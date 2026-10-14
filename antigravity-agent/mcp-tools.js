import { z } from 'zod';

export function registerTaskTools(server, context) {
  const { DEFAULT_MODEL, MAX_CONCURRENT, AGY_EXE } = context.config;
  const { waitRecoveries, liveTasks, terminalStatuses } = context.state;
  const { readActive, store, taskFile, readTask, withStateLock } = context.storage;
  const { taskTime, openProgressWindow, windowStatus, jsonResult, redact, taskOutput } = context.presentation;
  const { listModels } = context.models;
  const { pidIsAlive, recoverInterruptedTask, cancelTask } = context.recovery;
  const { refreshMessages, sendTaskMessage } = context.messaging;
  const { startTask, getTask } = context.runner;
  const { getChanges } = context.lifecycle;

server.registerTool("capabilities", {
  description: "Read available CLI models and current task state. Default task model is gemini-3.8-flash-high with high effort and full permissions; availability can change.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: {},
}, async () => {
  try {
    await recoverInterruptedTask();
    const models = await listModels();
    const tasks = await readActive();
    return jsonResult({ cli: AGY_EXE, models, defaults: { model: DEFAULT_MODEL, effort: "high", mode: "accept-edits", full_access: true, sandbox: false }, max_concurrent_tasks: MAX_CONCURRENT, active_task_ids: Object.keys(tasks), short_wait: { default_seconds: 20, max_seconds: 20, tool: 'wait_task' } });
  } catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("execute_task", {
  description: "Submit an authorized task once. Optionally reuse request_id to recover a lost submission reply without starting a duplicate; different parameters are refused. Returns task_id promptly while the native progress window opens in the background. For a result, use repeated wait_task calls for that ID. cwd must be an existing absolute directory. show_progress_window defaults to true; get_task confirms its display status. Defaults: gemini-3.8-flash-high, high, accept-edits and full CLI access; explicit restrictions take priority. Separate tasks run concurrently up to the configured limit.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    prompt: z.string().min(1).max(1000000),
    cwd: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    mode: z.enum(["plan", "accept-edits"]).optional(),
    sandbox: z.boolean().optional(),
    full_access: z.boolean().optional(),
    additional_dirs: z.array(z.string().min(1)).max(32).optional(),
    timeout_seconds: z.number().int().min(1).max(86400).optional(),
    show_progress_window: z.boolean().optional(),
    request_id: z.string().uuid().optional(),
  },
}, async (input) => {
  try {
    const result = await startTask(input);
    const progressWindow = result.idempotent_replay ? windowStatus(result.task_id) : input.show_progress_window === false ? { status: "not_requested" }
      : await openProgressWindow(result.task_id, taskFile(result.task_id), { waitForReady: false });
    return jsonResult({ task_id: result.task_id, status: result.status, progress_window: progressWindow,
      continue_waiting: !terminalStatuses.has(result.status), next_action: terminalStatuses.has(result.status) ? 'get_task' : 'wait_task',
      ...(result.idempotent_replay ? { idempotent_replay: true } : {}),
      ...(result.error ? { error: result.error } : {}) }, result.status === "failed", true);
  } catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("get_task", {
  description: "Retrieve saved output, message receipts and server-computed elapsed duration; quote elapsed rather than mixing UTC with local clocks. Follow next_offset for complete output. turn_index retrieves an earlier turn. A running task's output is not its final result. Reopen the window with open_progress_window without re-execution.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: { task_id: z.string().uuid(), offset: z.number().int().min(0).optional(),
    max_chars: z.number().int().min(1000).max(60000).optional(), diagnostics: z.boolean().optional(),
    turn_index: z.number().int().min(0).optional() },
}, async ({ task_id, offset, max_chars, diagnostics, turn_index }) => {
  try {
    const finishing = liveTasks.get(task_id);
    if (finishing?.finished) await finishing.closed;
    const record = await readTask(task_id);
    if (!record) throw new Error(`Task not found: ${task_id}`);
    await recoverInterruptedTask(task_id);
    const current = await readTask(task_id);
    await refreshMessages(current);
    return jsonResult({ ...(diagnostics ? await getTask(task_id) : taskOutput(current, offset, max_chars, turn_index)), progress_window: windowStatus(task_id) });
  }
  catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("wait_task", {
  description: "Wait up to 20 seconds for one existing task, without rerunning or cancelling it. A running result sets continue_waiting=true: call wait_task again in the current turn if the user needs the result. A terminal result includes saved output; follow next_offset with get_task for the remainder and continue the user's workflow. Tool cancellation stops only this wait, not the Agent. This is a bounded wait, not a scheduler or automatic wakeup.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: { task_id: z.string().uuid(), wait_seconds: z.number().min(0).max(20).default(20),
    offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(1000).max(60000).optional() },
}, async ({ task_id, wait_seconds, offset, max_chars }, extra) => {
  const started = performance.now();
  try {
    const deadline = started + wait_seconds * 1000;
    let record;
    while (true) {
      extra.signal?.throwIfAborted();
      const revision = getChanges().capture(taskFile(task_id));
      record = await readTask(task_id);
      if (!record) throw new Error(`Task not found: ${task_id}`);
      if (terminalStatuses.has(record.status) || performance.now() >= deadline) break;
      if (!pidIsAlive(record.ownerPid)) {
        // Recovery can involve slow Windows process checks. Keep this wait bounded;
        // the next wait/get observes recovery without blocking a network request.
        if (!waitRecoveries.has(task_id)) {
          const recovery = recoverInterruptedTask(task_id).catch(() => {}).finally(() => waitRecoveries.delete(task_id));
          waitRecoveries.set(task_id, recovery);
        }
        break;
      }
      await getChanges().wait(taskFile(task_id), revision, Math.max(1, Math.min(3000, deadline - performance.now())), extra.signal);
    }
    // A durable terminal file may precede the registry update by a few ms.
    // Join that existing transaction before reporting the task as finished.
    if (terminalStatuses.has(record.status)) record = await withStateLock(() => readTask(task_id));
    const done = terminalStatuses.has(record.status);
    const result = done ? taskOutput(await refreshMessages(record), offset, max_chars) : {
      task_id, status: record.status, ...taskTime(record), progress: record.lastProgress || null,
    };
    return jsonResult({ ...result, waited_seconds: Math.round((performance.now() - started) / 100) / 10,
      continue_waiting: !done, ...(waitRecoveries.has(task_id) ? { recovery_pending: true } : {}),
      next_action: result.state_persisted === false ? 'Preserve the available output before restarting; repair state storage. The CLI is not replayed.' : done ? result.next_offset != null ? 'get_task' : 'use_result' : 'wait_task' }, false, true);
  } catch (error) { return jsonResult({ task_id, error: redact(error.message), task_not_cancelled: true }, true, true); }
});

server.registerTool("list_tasks", {
  description: "List recent persisted task IDs, status and short output previews. Use this to retrieve results after a window closes or the conversation no longer has its task ID.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: { limit: z.number().int().min(1).max(20).optional() },
}, async ({ limit = 5 }) => {
  try {
    await recoverInterruptedTask();
    const ids = (await store.recent()).slice(0, limit);
    const tasks = await Promise.all(ids.map(async id => taskOutput(await refreshMessages(await readTask(id)), 0, 2000)));
    return jsonResult({ tasks });
  } catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("send_task_message", {
  description: "Send a follow-up to a running Antigravity task. mode=queue (default) waits for the current turn. mode=send_now waits for any active tool to finish, interrupts response generation, resumes the same CLI conversation and applies the new instruction before continuing the original task. Already completed actions are not rolled back. get_task reports queued/running/delivered/interrupted/failed receipts; acceptance is not delivery. Reuse request_id when retrying to prevent duplicates.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: { task_id: z.string().uuid(), message: z.string().min(1).max(20000),
    mode: z.enum(["queue", "send_now"]).default("queue"), request_id: z.string().uuid().optional() },
}, async ({ task_id, message, mode, request_id }) => {
  try { return jsonResult(await sendTaskMessage(task_id, message, mode, request_id), false, true); }
  catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("open_progress_window", {
  description: "Open the native Windows progress/result window for an existing task, without re-executing it. Reuses an open window in this server. Closing the window does not cancel the task. Chat retrieves the saved result using get_task; this window does not inject context into Chat.",
  annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id }) => {
  try {
    if (!await readTask(task_id)) throw new Error(`Task not found: ${task_id}`);
    const progressWindow = await openProgressWindow(task_id, await store.resolvedFile(task_id));
    return jsonResult({ task_id, progress_window: progressWindow }, progressWindow.status === "unavailable", true);
  } catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

server.registerTool("cancel_task", {
  description: "Cancel one specified task. Its owning server terminates only that task's Windows process tree, including when requested through another connection. Never cancel another Chat's task without user authorization.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  inputSchema: { task_id: z.string().uuid() },
}, async ({ task_id }) => {
  try {
    const result = await cancelTask(task_id);
    return jsonResult(result, result.status === "interrupted" && result.cleanup_state === "unknown");
  } catch (error) { return jsonResult({ error: redact(error.message) }, true); }
});

}
