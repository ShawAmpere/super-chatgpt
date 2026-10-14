import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function createTaskRecovery(context) {
  const { SERVER_ID, AGY_EXE } = context.config;
  const { ownerChecks, liveTasks, terminalStatuses } = context.state;
  const { execFileAsync, delay } = context.processes;
  const { readActive, saveActive, withStateLock, readJson, atomicWrite, taskFile, commitRecord, readTask, store } = context.storage;
  const { redact, publicRecord } = context.presentation;
  const { readMessages, saveMessages, messageReceipts } = context.messaging;
  const { getChanges } = context.lifecycle;

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}
async function queryAgyProcess(pid, startedAt, executable = AGY_EXE) {
  if (!Number.isInteger(pid) || pid < 1 || !startedAt || process.platform !== "win32") return "unknown";
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){[pscustomobject]@{path=$p.ExecutablePath; started=([datetime]$p.CreationDate).ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress}`;
  try {
    const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 5000, maxBuffer: 16384, windowsHide: true,
    });
    if (!stdout.trim()) return "gone";
    const processInfo = JSON.parse(stdout.trim());
    if (!processInfo?.path) return "unknown";
    const expectedPath = (await realpath(executable)).toLowerCase();
    if (path.resolve(processInfo.path).toLowerCase() !== expectedPath) return "gone";
    const delta = Math.abs(Date.parse(processInfo.started) - Date.parse(startedAt));
    return Number.isFinite(delta) && delta <= 5000 ? "alive" : "gone";
  } catch {
    return "unknown";
  }
}
let reconciled = false;
async function recoverInterruptedTask(taskId) {
  if (store && (taskId || !reconciled)) {
    await withStateLock(async () => {
      const tasks=await readActive();
      // One startup scan, then targeted recovery only. A record without its
      // registry entry can occur before launch or after final publication.
      for (const id of taskId ? [taskId] : await store.records()) {
        if(tasks[id])continue;
        const record=await store.read(id);
        if(!record || terminalStatuses.has(record.status) && !['pending','unknown'].includes(record.cleanupState))continue;
        if(pidIsAlive(record.ownerPid) && (!record.ownerStartedAt || !record.ownerExecutable ||
          await queryAgyProcess(record.ownerPid,record.ownerStartedAt,record.ownerExecutable)!=='gone'))continue;
        tasks[id]={taskId:id,ownerPid:record.ownerPid,serverId:record.serverId,ownerDead:true,
          ownerStartedAt:record.ownerStartedAt,ownerExecutable:record.ownerExecutable,
          agyPid:record.agyPid,agyStartedAt:record.agyStartedAt,jobManaged:record.jobManaged,
          processExecutable:record.processExecutable,status:record.status,stage:record.agyPid?'running':'reserved'};
      }
      if(Object.keys(tasks).length)await saveActive(tasks);
    });
    reconciled=true;
  }
  const snapshot = await readActive();
  for (const observed of Object.values(snapshot).filter((task) => !taskId || task.taskId === taskId)) {
    if (!observed.ownerDead && observed.ownerPid === process.pid && observed.serverId === SERVER_ID) continue;
    let ownerDead = observed.ownerDead || !pidIsAlive(observed.ownerPid);
    if (!ownerDead && observed.ownerStartedAt && observed.ownerExecutable) {
      const key = `${observed.ownerPid}:${observed.ownerStartedAt}`;
      let cached = ownerChecks.get(key);
      if (!cached || Date.now() - cached.at > 10000) {
        cached = { at: Date.now(), identity: await queryAgyProcess(observed.ownerPid, observed.ownerStartedAt, observed.ownerExecutable) };
        ownerChecks.set(key, cached);
        if (ownerChecks.size > 256) ownerChecks.delete(ownerChecks.keys().next().value);
      }
      if (cached.identity === "gone") ownerDead = true;
    }
    if (!ownerDead) continue;
    const candidate = await withStateLock(async () => {
    const tasks = await readActive();
    const active = tasks[observed.taskId];
    if (!active || active.serverId !== observed.serverId || active.ownerPid !== observed.ownerPid || active.ownerStartedAt !== observed.ownerStartedAt) return null;
    const file = taskFile(active.taskId);
    const record = await readJson(file);
    if (record && !terminalStatuses.has(record.status)) {
      const messages = await readMessages(record.id);
      for (const message of messages.filter((item) => ["queued", "interrupt_requested", "dispatching", "running"].includes(item.status))) {
        message.status = "failed"; message.error = "The owning server stopped before delivery completed.";
      }
      await saveMessages(record.id, messages);
      await atomicWrite(file, {
        ...record, status: "interrupted", finishedAt: new Date().toISOString(),
        messages: messageReceipts(messages),
        error: "The owning MCP server stopped before the CLI reported a terminal result.",
      });
    }
    tasks[active.taskId] = { ...active, status: "interrupted", ownerDead: true };
    await saveActive(tasks);
    return { ...active, ownerDead: true,
      durableTerminal: terminalStatuses.has(record?.status) && !['pending','unknown'].includes(record.cleanupState) };
  });
  if (!candidate) continue;
  let childState = candidate.durableTerminal ? 'gone' : candidate.agyPid
    ? await queryAgyProcess(candidate.agyPid, candidate.agyStartedAt, candidate.processExecutable)
    : candidate.stage === "launching" && !candidate.jobManaged ? "unknown" : "gone";
  if (childState === "alive" && candidate.jobManaged) {
    await killProcessTree(candidate.agyPid).catch(() => {});
    childState = await queryAgyProcess(candidate.agyPid, candidate.agyStartedAt, candidate.processExecutable);
  }
  await withStateLock(async () => {
    const tasks = await readActive();
    const current = tasks[candidate.taskId];
    if (!current?.ownerDead || current.serverId !== candidate.serverId) return;
    if (childState === "gone" && (candidate.jobManaged || candidate.stage !== "running")) delete tasks[candidate.taskId];
    else tasks[candidate.taskId] = { ...current, orphanedAgyProcess: childState, cleanupState: "unknown" };
    await saveActive(tasks);
  });
  }
}
async function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid < 1) return;
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    return;
  }
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  try {
    await execFileAsync(taskkill, ["/PID", String(pid), "/T", "/F"], { timeout: 10000, windowsHide: true });
  } catch (error) {
    throw new Error(error.code === "ETIMEDOUT"
      ? "Windows process-tree cleanup timed out."
      : `Windows process-tree cleanup failed (exit ${error.exitCode ?? error.code ?? "unknown"}).`);
  }
}
async function requestCleanup(runtime) {
  if (!runtime.cleanupPromise || runtime.cleanupState === "unknown") {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null || runtime.childClosed) {
      runtime.cleanupState = runtime.record.jobManaged ? "confirmed" : "unknown";
      runtime.cleanupError = runtime.record.jobManaged ? null : "The CLI root exited; descendant state is unconfirmed.";
      runtime.cleanupPromise = Promise.resolve();
      return runtime.cleanupPromise;
    }
    runtime.cleanupState = "pending";
    runtime.cleanupPromise = (async () => {
      try {
        await killProcessTree(runtime.child.pid);
        runtime.cleanupState = "confirmed";
      } catch (error) {
        runtime.cleanupError = redact(error.message);
        const processState = await queryAgyProcess(runtime.child.pid, runtime.record.agyStartedAt, runtime.record.processExecutable);
        runtime.cleanupState = processState === "gone" && runtime.record.jobManaged ? "confirmed" : "unknown";
      }
    })();
  }
  return runtime.cleanupPromise;
}
async function cancelTask(id) {
  await recoverInterruptedTask(id);
  const runtime = liveTasks.get(id);
  if (runtime?.finished) {
    runtime.cancelRequested = true;
    await runtime.closed;
    if (liveTasks.get(id) && liveTasks.get(id) !== runtime) return cancelTask(id);
    return publicRecord(await readTask(id) || runtime.record, true);
  }
  const record = runtime?.record || await readTask(id);
  if (!record) throw new Error(`Task not found: ${id}`);
  if (terminalStatuses.has(record.status) && record.cleanupState !== "unknown") return publicRecord(record, true);
  if (!runtime) {
    await withStateLock(async () => {
      const tasks = await readActive();
      if (!tasks[id] || !pidIsAlive(tasks[id].ownerPid)) throw new Error("Task has no live owner; recover its state before retrying cancellation.");
      tasks[id] = { ...tasks[id], cancelRequested: true, cancelRequestedAt: new Date().toISOString() };
      await saveActive(tasks);
    });
    // The owner terminates its own Job Object; never kill a process by a stale PID.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const revision = getChanges().capture(taskFile(id));
      const current = await readTask(id);
      if (terminalStatuses.has(current?.status)) return publicRecord(current, true);
      await getChanges().wait(taskFile(id), revision, Math.min(1000, deadline-Date.now()));
    }
    return { ...publicRecord(await readTask(id), true), cancellation_requested: true };
  }
  runtime.cancelRequested = true;
  runtime.record.status = "cancelling";
  await commitRecord(runtime.record);
  await requestCleanup(runtime);
  if (!runtime.finished) {
    runtime.record.cleanupState = runtime.cleanupState;
    runtime.record.cleanupError = runtime.cleanupError || null;
    if (runtime.cleanupState === "unknown") runtime.record.error = `Could not confirm process-tree cleanup: ${runtime.cleanupError || "process state is unknown"}.`;
    await commitRecord(runtime.record);
  }
  await Promise.race([runtime.closed, delay(5000)]);
  return publicRecord(await readTask(id) || runtime.record, true);
}
async function shutdown() {
  for (const runtime of liveTasks.values()) {
    if (runtime.finished) continue;
    runtime.cancelRequested = true;
    await requestCleanup(runtime);
    await Promise.race([runtime.closed, delay(5000)]);
    if (!runtime.finished) {
      runtime.record.status = "interrupted";
      runtime.record.cleanupState = runtime.cleanupState;
      runtime.record.cleanupError = runtime.cleanupError || null;
      runtime.record.error = "The MCP server shut down before Antigravity reported a terminal result.";
      runtime.record.finishedAt = new Date().toISOString();
      await commitRecord(runtime.record).catch(() => {});
      runtime.finished = true;
      runtime.resolveClosed?.();
      liveTasks.delete(runtime.record.id);
    }
  }
}

  return { pidIsAlive, queryAgyProcess, recoverInterruptedTask, killProcessTree, requestCleanup, cancelTask, shutdown };
}
