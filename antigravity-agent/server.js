import { agentStateRoot, migrateAgentState } from './state-location.js';
import { registerTaskTools } from './mcp-tools.js';
import { createMessageQueue } from './message-queue.js';
import { createTaskRecovery } from './task-recovery.js';
import { createTaskRunner } from './task-runner.js';
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openProgressWindow, windowStatus } from "./progress-window.js";
import { taskTime } from "./task-time.js";
import { activeTasks, activeRegistry, concurrencyLimit } from "./active-state.js";
import { computerRequest } from "../local-computer-control/service-client.js";

import { stateLock } from './state-lock.js';
import { StateEvents } from './state-events.js';
import { TaskStore, readJson, atomicWrite } from './task-store.js';
import { createDesktopLauncher } from '../local-computer-control/parent-launcher.js';
import { redactSecrets } from '../shared/errors.js';
import { pythonExecutable, resolveExecutable } from '../shared/runtime-paths.js';

const execFileAsync = promisify(execFile);
const SERVER_ID = randomUUID();
const OWNER_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();
const DATA_ROOT = agentStateRoot();
const TASKS_DIR = path.join(DATA_ROOT, "tasks");
const MESSAGES_DIR = path.join(DATA_ROOT, "messages");
const LOCK_FILE = path.join(DATA_ROOT, "state.guard");
const PYTHON_EXE = process.env.ANTIGRAVITY_AGENT_PYTHON || pythonExecutable();
const PROCESS_SUPPORT = fileURLToPath(new URL("./process-support.py", import.meta.url));
const DEFAULT_MODEL = "gemini-3.8-flash-high";
const ACTIVE_FILE = path.join(DATA_ROOT, "active.json");
const MAX_CONCURRENT = concurrencyLimit(process.env.ANTIGRAVITY_AGENT_MAX_CONCURRENT);
const COMPUTER_ENABLED = process.env.ANTIGRAVITY_AGENT_COMPUTER_CONTROL !== '0';
const ownerChecks = new Map();
const waitRecoveries = new Map();
const AGY_PATH = resolveExecutable(process.env.AGY_EXECUTABLE || 'agy.exe');
const AGY_EXE = AGY_PATH !== 'agy.exe' ? AGY_PATH : path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "agy", "bin", "agy.exe",
);
const liveTasks = new Map();
// At most the configured active slots: failed publication never frees a slot.
const unsavedTasks = new Map();
const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted", "needs_input"]);
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 2 * 1024 * 1024;
let serverStopping = false;

function jsonResult(value, isError = false, structured = false) {
  const safe = redact(value);
  if (isError && safe && typeof safe === "object" && safe.error && !safe.code) {
    safe.retryable = /busy|lock|recovery|persist|cleanup|concurrency limit/i.test(safe.error);
    safe.code = safe.retryable ? "RECOVERY_REQUIRED" : "TASK_REQUEST_FAILED";
    safe.next_action = safe.retryable ? "Inspect list_tasks and cleanup state; retry only after the active task or recovery finishes." : "Check task parameters and CLI availability; do not substitute a requested model.";
  }
  return {
    content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
    ...(structured ? { structuredContent: safe } : {}),
    isError,
  };
}

const redact = value => redactSecrets(value);

function taskFile(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid task id.");
  return path.join(TASKS_DIR, `${id}.json`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readActive = async () => activeTasks(await readJson(ACTIVE_FILE));
const saveActive = async (tasks) => atomicWrite(ACTIVE_FILE, activeRegistry(tasks));

const store = new TaskStore(DATA_ROOT);
const lock = stateLock(PYTHON_EXE, PROCESS_SUPPORT, LOCK_FILE, withoutTunnelKey());
const withStateLock = action => lock.run(action);
let changes, desktopLauncher;
async function desktopActivation() {
  if (!desktopLauncher) {
    const pending = createDesktopLauncher();
    desktopLauncher = pending;
    // Failed optional initialization must not poison the lifetime of this server.
    void pending.catch(() => { if (desktopLauncher === pending) desktopLauncher = null; });
  }
  return await desktopLauncher;
}

function withoutTunnelKey() {
  const environment = { ...process.env };
  delete environment.CONTROL_PLANE_API_KEY;
  return environment;
}

function modelEffortSuffix(model) {
  return model.match(/-(low|medium|high|max)$/)?.[1] || null;
}

function isPermissionDenial(value) {
  const message = typeof value === "string" ? value : JSON.stringify(value);
  return /soft[-\s]?denied|permission[^\r\n]{0,120}(?:denied|blocked|required)|approval[^\r\n]{0,120}(?:denied|required)|(?:not allowed|forbidden|blocked by policy)/i.test(message);
}

function parseModelNames(output) {
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const first = line.trim().split(/\t| {2,}/, 1)[0]?.trim();
    if (first && first.toLowerCase() !== "model" && /^[A-Za-z][A-Za-z0-9._:-]*$/.test(first)) names.push(first);
  }
  return [...new Set(names)];
}

async function listModels() {
  await access(AGY_EXE);
  const { stdout } = await execFileAsync(AGY_EXE, ["models"], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const names = parseModelNames(stdout);
  if (!names.length) throw new Error("The Antigravity CLI returned no parseable model names.");
  return names.map((model) => {
    const variant = modelEffortSuffix(model);
    return { model, effort_support: variant ? "encoded_in_model_name" : "unknown", encoded_effort: variant };
  });
}

function publicRecord(record, includeOutput = false) {
  const suffix = modelEffortSuffix(record.requestedModel);
  const resolvedMatch = record.resolvedModel ? record.resolvedModel === record.requestedModel : null;
  const value = {
    task_id: record.id, status: record.status, ...taskTime(record),
    state_persisted: record.statePersisted !== false,
    ...messageSummary(record),
    requested_model: record.requestedModel, requested_effort: record.requestedEffort,
    resolved_model: record.resolvedModel || null, effort_verified: record.effortVerified,
    selection_validated: resolvedMatch === true && suffix === record.requestedEffort,
    effort_suffix_match: suffix ? suffix === record.requestedEffort : null,
    model_resolution_match: resolvedMatch,
    resolved_model_mismatch: Boolean(record.resolvedModel && record.resolvedModel !== record.requestedModel),
    mode: record.mode, sandbox: record.sandbox, full_access: record.fullAccess,
    cwd: record.cwd, additional_dirs: record.additionalDirs || [],
    timeout_seconds: record.timeoutSeconds, result_status: record.resultStatus || null,
    exit_code: record.exitCode ?? null, permission_notice: record.permissionNotice || false,
    progress: record.lastProgress || null, error: record.error || null,
    cleanup_state: record.cleanupState || "not_requested", cleanup_error: record.cleanupError || null,
    protocol_error: record.protocolError || false,
    computer_control: record.computerControl ? { ...record.computerControl, owner_id: undefined } : null,
  };
  if (includeOutput) {
    value.result_available = Boolean(record.resultEvent);
    value.result = record.resultEvent || null;
    value.stderr_summary = record.stderrSummary || null;
  }
  return redactSecrets(value, [record.computerControl?.owner_id]);
}

function storedRecord(record) {
  return redact({
    id: record.id, requestFingerprint: record.requestFingerprint || null, status: record.status, createdAt: record.createdAt,
    startedAt: record.startedAt || null, finishedAt: record.finishedAt || null,
    requestedModel: record.requestedModel, requestedEffort: record.requestedEffort,
    resolvedModel: record.resolvedModel || null, effortVerified: record.effortVerified,
    mode: record.mode, sandbox: record.sandbox, fullAccess: record.fullAccess,
    cwd: record.cwd, additionalDirs: record.additionalDirs || [],
    timeoutSeconds: record.timeoutSeconds, resultStatus: record.resultStatus || null,
    exitCode: record.exitCode ?? null, permissionNotice: record.permissionNotice || false,
    lastProgress: record.lastProgress || null, error: record.error || null,
    stderrSummary: record.stderrSummary || null, resultEvent: record.resultEvent || null,
    lastActivityAt: record.lastActivityAt || null, progressEvents: record.progressEvents || [],
    protocolError: record.protocolError || false,
    ownerPid: process.pid, serverId: SERVER_ID, agyPid: record.agyPid || null,
    ownerStartedAt: OWNER_STARTED_AT, ownerExecutable: process.execPath,
    jobManaged: record.jobManaged || false, processExecutable: record.processExecutable || AGY_EXE,
    agyStartedAt: record.agyStartedAt || null, cleanupState: record.cleanupState || "not_requested",
    cleanupError: record.cleanupError || null,
    conversationId: record.conversationId || null, inputSeen: record.inputSeen || false,
    currentMessageId: record.currentMessageId || null, turnIndex: record.turnIndex || 0,
    turns: record.turns || [], messages: record.messages || [],
    totalStreamBytes: record.totalStreamBytes || 0,
    steeringMethod: record.steeringMethod || null,
    computerControl: record.computerControl || null,
  });
}

async function commitRecord(record, beforeCommit) {
  await withStateLock(async () => {
    if (beforeCommit) await beforeCommit();
    const file = taskFile(record.id);
    const saved = await readJson(file) || {};
    const merged = { ...saved, ...storedRecord(record), agyPid: record.agyPid || saved.agyPid || null };
    const tasks = await readActive();
    const active = tasks[record.id];
    await store.commit(merged, async () => {
    if (active?.serverId === SERVER_ID) {
      if (terminalStatuses.has(record.status) && !["pending", "unknown"].includes(record.cleanupState)) delete tasks[record.id];
      else tasks[record.id] = {
        ...active, status: record.status, agyPid: record.agyPid || active.agyPid || null,
        agyStartedAt: record.agyStartedAt || active.agyStartedAt || null,
        stage: record.agyPid ? "running" : active.stage, cleanupState: record.cleanupState || active.cleanupState || null,
        jobManaged: record.jobManaged || active.jobManaged || false,
        processExecutable: record.processExecutable || active.processExecutable || AGY_EXE,
      };
      if (JSON.stringify(active) !== JSON.stringify(tasks[record.id])) await saveActive(tasks);
    }
    }
    );
    changes?.notify(file);
  });
}

async function readTask(id) {
  return unsavedTasks.get(id) || store.read(id);
}

async function getTask(id) {
  await recoverInterruptedTask(id);
  const runtime = liveTasks.get(id);
  if (runtime?.finished) await runtime.closed;
  const record = await readTask(id);
  if (!record) throw new Error(`Task not found: ${id}`);
  if (runtime && !runtime.finished && liveTasks.get(id) === runtime) {
    record.stderrSummary = redact(runtime.stderrText.slice(-4000)).trim() || record.stderrSummary || null;
    record.lastProgress = runtime.record.lastProgress || record.lastProgress;
    record.lastActivityAt = runtime.record.lastActivityAt || record.lastActivityAt;
    record.conversationId = runtime.record.conversationId || record.conversationId;
    record.resolvedModel = runtime.record.resolvedModel || record.resolvedModel;
  }
  return { ...publicRecord(await refreshMessages(record), true), active_tools: runtime && !runtime.finished ? [...runtime.activeTools] : [] };
}

function taskOutput(record, offset = 0, maxChars = 24000, turnIndex) {
  const selected = turnIndex === undefined ? null : record.turns?.find((turn) => turn.index === turnIndex);
  if (turnIndex !== undefined && !selected) throw new Error("Requested turn has no saved result yet.");
  const raw = (selected?.result || record.resultEvent)?.result?.response;
  const text = redactSecrets(raw == null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw), [record.computerControl?.owner_id]);
  if (offset > text.length) throw new Error("Result offset is beyond the end of the output.");
  const next = Math.min(text.length, offset + maxChars);
  return { task_id: record.id, status: record.status, ...taskTime(record), ...messageSummary(record),
    state_persisted: record.statePersisted !== false,
    output: text.slice(offset, next), result_is_final: terminalStatuses.has(record.status),
    output_turn_index: selected?.index ?? record.turnIndex ?? 0,
    next_offset: next < text.length ? next : null, output_chars: text.length,
    error: record.error || null, cleanup_state: record.cleanupState || "not_requested",
    requested_model: record.requestedModel, resolved_model: record.resolvedModel || null,
    requested_effort: record.requestedEffort, effort_verified: record.effortVerified || false };
}

// Explicit role interfaces keep module dependencies visible. Late callbacks
// resolve the runner/recovery/message cycle after all factories are composed.
const context = {
  config: { SERVER_ID, OWNER_STARTED_AT, TASKS_DIR, MESSAGES_DIR, PYTHON_EXE, PROCESS_SUPPORT, DEFAULT_MODEL,
    ACTIVE_FILE, MAX_CONCURRENT, COMPUTER_ENABLED, AGY_EXE, MAX_STREAM_BYTES, MAX_STREAM_LINE_BYTES },
  state: { liveTasks, terminalStatuses, ownerChecks, waitRecoveries, unsavedTasks },
  storage: { readActive, saveActive, store, withStateLock, readJson, atomicWrite, taskFile,
    readTask, commitRecord, storedRecord },
  processes: { execFileAsync, delay, withoutTunnelKey },
  models: { modelEffortSuffix, isPermissionDenial, listModels },
  presentation: { taskTime, openProgressWindow, windowStatus, jsonResult, redact, publicRecord, taskOutput },
  desktop: { computerRequest, desktopActivation },
  runner: { startTask: (...args) => startTask(...args), getTask },
  recovery: { pidIsAlive: (...args) => pidIsAlive(...args), recoverInterruptedTask: (...args) => recoverInterruptedTask(...args),
    requestCleanup: (...args) => requestCleanup(...args), cancelTask: (...args) => cancelTask(...args) },
  messaging: {
    messageFile: (...args) => messageFile(...args), readMessages: (...args) => readMessages(...args),
    saveMessages: (...args) => saveMessages(...args), pendingMessages: (...args) => pendingMessages(...args),
    messageReceipts: (...args) => messageReceipts(...args), refreshMessages: (...args) => refreshMessages(...args),
    sendTaskMessage: (...args) => sendTaskMessage(...args), inspectInbox: (...args) => inspectInbox(...args),
  },
  lifecycle: { isStopping: () => serverStopping, getChanges: () => changes },
};
const { startTask } = createTaskRunner(context);
const { pidIsAlive, recoverInterruptedTask, requestCleanup, cancelTask, shutdown } = createTaskRecovery(context);
const { messageFile, readMessages, saveMessages, pendingMessages, messageReceipts, messageSummary, refreshMessages, sendTaskMessage, inspectInbox } = createMessageQueue(context);

const server = new McpServer({ name: "antigravity-agent", version: "0.1.0" }, {
  instructions: "Delegate only when authorized. Submit once with execute_task and retain its ID. When a result is needed, keep calling wait_task (20 seconds maximum) while continue_waiting=true; retrieve all next_offset pages, assess the result and continue the workflow. Background-only requests may return promptly. A network error is not task failure: inspect saved state before resubmitting. Native progress windows never inject context or wake an ended turn. Different chats own separate task IDs; do not message/cancel another chat's task without authorization. Preserve explicit model, effort, directory and restrictions across follow-ups. Defaults: gemini-3.8-flash-high, high, accept-edits, full CLI access. Never silently substitute a model; model identity is separate from effort telemetry. Tool descriptions specify message receipts, result paging and reopen/cancel behavior.",
});

registerTaskTools(server, context);

async function main() {
  await mkdir(TASKS_DIR, { recursive: true });
  await mkdir(MESSAGES_DIR, { recursive: true });
  await withStateLock(() => migrateAgentState(store, PYTHON_EXE, PROCESS_SUPPORT, withoutTunnelKey()));
  changes = new StateEvents([DATA_ROOT, TASKS_DIR, MESSAGES_DIR]);
  await recoverInterruptedTask();
  await withStateLock(() => store.rebuildRecent());
  const transport = new StdioServerTransport();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    serverStopping = true;
    await shutdown();
    changes.close();
    await lock.close();
    await desktopLauncher?.then(value => value.close()).catch(() => {});
    await server.close().catch(() => {});
  };
  transport.onclose = () => { void stop(); };
  process.stdin.once("end", () => { void stop(); });
  process.stdin.once("close", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await server.connect(transport);
}

main().catch(async (error) => {
  process.stderr.write(`antigravity-agent MCP startup failed: ${redact(error.message)}\n`);
  serverStopping = true;
  changes?.close();
  await lock.close().catch(() => {});
  await desktopLauncher?.then(value => value.close()).catch(() => {});
  await server.close().catch(() => {});
  process.exitCode = 1;
});
