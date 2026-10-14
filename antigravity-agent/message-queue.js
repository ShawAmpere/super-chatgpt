import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function createMessageQueue(context) {
  const { MESSAGES_DIR, PYTHON_EXE, PROCESS_SUPPORT } = context.config;
  const { liveTasks, terminalStatuses } = context.state;
  const { readActive, withStateLock, readJson, atomicWrite, taskFile, commitRecord, readTask } = context.storage;
  const { execFileAsync, withoutTunnelKey } = context.processes;
  const { redact } = context.presentation;
  const { pidIsAlive, recoverInterruptedTask, requestCleanup } = context.recovery;

function messageFile(id) { taskFile(id); return path.join(MESSAGES_DIR, `${id}.json`); }
async function readMessages(id) { return await readJson(messageFile(id)) || []; }
async function saveMessages(id, messages) {
  await mkdir(MESSAGES_DIR, { recursive: true });
  await atomicWrite(messageFile(id), messages);
}
function pendingMessages(messages) {
  return messages.filter((item) => ["queued", "interrupt_requested"].includes(item.status))
    .sort((a, b) => (a.mode === "send_now" ? 0 : 1) - (b.mode === "send_now" ? 0 : 1) || a.sequence - b.sequence);
}
function messageReceipts(messages) {
  return messages.map(({ text, ...message }) => ({ ...message, preview: redact(text.slice(0, 200)) }));
}
function messageSummary(record) {
  return { conversation_id: record.conversationId || null, steering_method: record.steeringMethod || null,
    current_turn_index: record.turnIndex || 0, current_message_id: record.currentMessageId || null,
    pending_message_count: (record.messages || []).filter((item) => ["queued", "interrupt_requested", "dispatching"].includes(item.status)).length,
    messages: (record.messages || []).slice(-20), message_count: (record.messages || []).length,
    turns: (record.turns || []).map(({ result, ...turn }) => ({ ...turn, result_available: Boolean(result) })),
  };
}
async function refreshMessages(record) { record.messages = messageReceipts(await readMessages(record.id)); return record; }
async function sendTaskMessage(id, text, mode, requestId) {
  await recoverInterruptedTask(id);
  let receipt;
  await withStateLock(async () => {
    const messages = await readMessages(id);
    const duplicate = requestId && messages.find((message) => message.id === requestId);
    if (duplicate) {
      if (duplicate.text !== text || duplicate.mode !== mode) throw new Error("request_id was already used for a different message.");
      receipt = { ...messageReceipts([duplicate])[0], duplicate: true }; return;
    }
    const record = await readTask(id);
    if (!record) throw new Error(`Task not found: ${id}`);
    const active = (await readActive())[id];
    if (terminalStatuses.has(record.status) || !active || active.cancelRequested || !pidIsAlive(active.ownerPid)) {
      throw new Error("The task is no longer running; the message was not accepted.");
    }
    if (messages.length >= 100 || pendingMessages(messages).length >= 20) throw new Error("Message queue limit reached (20 pending, 100 total per task).");
    const message = { id: requestId || randomUUID(), sequence: messages.length, mode, text,
      status: "queued", createdAt: new Date().toISOString() };
    messages.push(message); await saveMessages(id, messages);
    receipt = messageReceipts([message])[0];
  });
  const runtime = liveTasks.get(id);
  if (runtime) void inspectInbox(runtime).catch(() => {});
  return { task_id: id, message: receipt,
    note: "Accepted into the durable queue. Acceptance is not delivery; inspect get_task message receipts. send_now waits for active tools to finish, sends a console interrupt and resumes the same conversation; completed side effects are not rolled back." };
}
async function inspectInbox(runtime) {
  if (runtime.finished || runtime.resultEvent || runtime.checkingInbox) return;
  runtime.checkingInbox = true;
  try {
  const active = (await readActive())[runtime.record.id];
  if (active?.cancelRequested && !runtime.finished && !runtime.cancelRequested) {
    runtime.cancelRequested = true;
    runtime.record.status = "cancelling";
    await commitRecord(runtime.record);
    await requestCleanup(runtime);
    return;
  }
  if (runtime.finished || runtime.cancelRequested || runtime.timedOut || runtime.interruptRequested) return;
  const observed = await readMessages(runtime.record.id);
  if (runtime.finished || runtime.resultEvent) return;
  runtime.hasQueuedMessages = pendingMessages(observed).length > 0;
  const fingerprint = observed.map((message) => `${message.id}:${message.status}`).join('|');
  const readyToInterrupt = runtime.record.conversationId && runtime.record.inputSeen && runtime.activeTools.size === 0 && pendingMessages(observed).some((message) => message.mode === "send_now");
  if (!readyToInterrupt && fingerprint === (runtime.inboxFingerprint || "")) return;
  runtime.checkingInbox = true;
  let interrupt = false;
  try {
    if (runtime.finished || runtime.resultEvent) return;
    await commitRecord(runtime.record, async () => {
      const messages = await readMessages(runtime.record.id);
      const immediate = pendingMessages(messages).find((message) => message.mode === "send_now");
      if (immediate && runtime.record.conversationId && runtime.record.inputSeen && runtime.activeTools.size === 0 && !runtime.finished && !runtime.cancelRequested && !runtime.timedOut) {
        immediate.status = "interrupt_requested";
        runtime.interruptRequested = true;
        runtime.record.status = "resuming";
        runtime.record.steeringMethod = "console_interrupt_and_resume_conversation_at_tool_boundary";
        interrupt = true;
      }
      if (immediate && !interrupt && runtime.activeTools.size > 0) immediate.wait_reason = "waiting_for_active_tool_to_finish";
      runtime.record.messages = messageReceipts(messages);
      runtime.inboxFingerprint = messages.map((message) => `${message.id}:${message.status}`).join('|');
      await saveMessages(runtime.record.id, messages);
    });
    if (interrupt) {
      try {
        if (runtime.finished || runtime.childClosed) return;
        // Do not interrupt a tool that began while the receipt was being persisted.
        if (runtime.activeTools.size > 0) { runtime.interruptRequested = false; runtime.record.status = "running"; return; }
        const control = await readJson(runtime.controlFile);
        if (control?.supervisor_pid !== runtime.child.pid || !Number.isInteger(control?.pid)) throw new Error("CLI console ownership is unconfirmed.");
        runtime.interruptSent = true;
        await execFileAsync(PYTHON_EXE, [PROCESS_SUPPORT, "interrupt", String(control.pid)], {
          windowsHide: true, env: withoutTunnelKey(), timeout: 5000, maxBuffer: 8192,
        });
        // A failed graceful stop must not be disguised as successful steering.
        let interruptTimer;
        try { await Promise.race([runtime.closed, new Promise((resolve) => { interruptTimer = setTimeout(resolve, 15000); })]); }
        finally { clearTimeout(interruptTimer); }
        if (!runtime.childClosed) {
          runtime.interruptFailure = "CLI did not stop after the interrupt signal; continuation was not attempted.";
          await requestCleanup(runtime);
        }
      } catch (error) {
        if (runtime.childClosed) return;
        runtime.interruptFailure = redact(error.message);
        runtime.interruptRequested = false;
        runtime.record.status = "running";
        await commitRecord(runtime.record, async () => {
          const messages = await readMessages(runtime.record.id);
          for (const message of messages.filter((item) => item.status === "interrupt_requested")) {
            message.status = "failed"; message.error = `Interruption failed: ${runtime.interruptFailure}`;
          }
          await saveMessages(runtime.record.id, messages); runtime.record.messages = messageReceipts(messages);
        });
      }
    }
  } finally { runtime.checkingInbox = false; }
  } finally { runtime.checkingInbox = false; }
}

  return { messageFile, readMessages, saveMessages, pendingMessages, messageReceipts, messageSummary, refreshMessages, sendTaskMessage, inspectInbox };
}
