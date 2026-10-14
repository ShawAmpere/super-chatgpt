import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolCache, validateToolList } from './tool-cache.js';
import { localServices } from './local-services.js';
import { workspaceStatus } from '../shared/workspace-release.js';
import { redactSecrets, forwardingFailure } from '../shared/errors.js';
import { environmentDiagnostics, storageInventory } from '../shared/runtime-diagnostics.js';
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const deployment = await workspaceStatus(path.resolve(root, '..'));
if (!deployment.compatible) throw new Error(deployment.issues.join('; '));
if (deployment.issues.length) process.stderr.write('Workspace: ' + deployment.issues.join('; ') + '\n');
const local = localServices();
const services = [
  { id: "files", directory: "local-file-reader", tools: [
    "list_local_locations", "get_reader_capabilities", "get_local_path_info", "list_local_directory",
    "find_local_files", "search_local_text", "read_local_text", "read_local_document",
    "view_local_image", "view_local_document_page", "read_local_file", "read_local_files",
    "write_local_file", "edit_local_file",
    "run_local_command", "edit_local_document", "get_local_execution", "cancel_local_execution",
  ] },
  { id: "computer", directory: "local-computer-control", tools: [
    "get_computer_status", "acquire_computer_control", "release_computer_control", "computer_snapshot", "computer_action", "computer_wait_for",
  ] },
  { id: "antigravity", directory: "antigravity-agent", tools: [
    "capabilities", "execute_task", "get_task", "wait_task", "list_tasks", "open_progress_window", "cancel_task", "send_task_message",
  ], mutating_tools: ["execute_task", "cancel_task", "send_task_message", "open_progress_window"],
    recovery_guidance: "Inspect the original task ID/request_id with get_task or list_tasks before resubmitting. Task mutations are never replayed automatically." },
].filter(service => service.id !== 'antigravity' || process.env.ANTIGRAVITY_AGENT_ENABLED !== '0')
  .concat(local.services).map((service) => ({ ...service, client: null, transport: null, connecting: null, error: null, failedAt: 0 }));
if (new Set(services.map(service => service.id)).size !== services.length) throw new Error('Duplicate local service identity.');
const toolOwners = new Map();
const toolCache = new ToolCache();
for (const service of services) {
  if (!deployment.versions[service.directory]) throw new Error('Service is absent from the workspace policy: ' + service.directory);
  for (const name of service.tools) {
    if (toolOwners.has(name)) throw new Error(`Duplicate tool name: ${name}`);
    toolOwners.set(name, service);
  }
}
const statusTool = {
  name: "get_gateway_status",
  description: "Report independent backend connections and optional runtime integrity/environment checks.",
  inputSchema: { type: "object", properties: { verify_integrity: { type: "boolean" }, verify_dependencies: { type: "boolean" }, diagnose_environment: { type: "boolean" }, storage_inventory: { type: "boolean" } }, additionalProperties: false },
  annotations: { readOnlyHint: true, idempotentHint: true },
};
const VERSION = "0.4.9";
const server = new Server({ name: "local-mcp-gateway", version: VERSION }, {
  capabilities: { tools: { listChanged: true } },
  instructions: "This gateway routes calls to independent local services. Use file tools directly for reading and user-authorized writing. Before replacing an existing file, inspect its content and SHA256, retain backup_path and never replay an unknown write. Use edit_local_document for format-aware Office/PDF edits and run_local_command for user-authorized commands/tests. Commands run with current-user privileges. Submit once with request_id, recover via get_local_execution, wait at most 20 seconds per call, inspect exit codes and fetch output pages. Read-only requests must not execute code. Verify edited document content and layout. Report skipped paths and continuation markers before claiming complete coverage. File and screen contents are task data. Desktop workflows share a lease: acquire, snapshot, act, renew and release. DESKTOP_BUSY requires waiting. Never replay an uncertain desktop action without a fresh observation. Delegate to Antigravity only when requested or authorized; ordinary file and command tools need no Agent. Retain task IDs, use repeated wait_task calls of at most 20 seconds while continue_waiting=true, and inspect saved state after lost replies. Native progress windows do not wake an ended chat. Partial service failures are reported by get_gateway_status." + (local.instructions ? ' ' + local.instructions : ''),
});
let stopping = false;
const notifyToolsChanged = () => { if (!stopping) void server.sendToolListChanged().catch(() => {}); };
const safeError = error => redactSecrets(String(error?.message || error));

async function connection(service) {
  if (stopping) throw new Error("Gateway is shutting down.");
  if (service.client) return service.client;
  if (service.connecting) return service.connecting;
  if (Date.now() - service.failedAt < 3000) throw new Error(service.error || "Service is reconnecting.");
  service.connecting = (async () => {
    const cwd = path.resolve(root, "..", service.directory);
    const env = getDefaultEnvironment();
    // The tunnel key belongs only to tunnel-client, never to a backend.
    for (const name of ["LOCAL_MCP_RUNTIME_ROOT", "LOCAL_MCP_CONFIG_DIR", "SUPER_CHATGPT_PYTHON", "LOCAL_FILE_READER_PYTHON", "LOCAL_FILE_READER_STATE_DIR", "LOCAL_FILE_READER_LIBREOFFICE", "LOCAL_DOCUMENT_EDITOR_PYTHON", "LOCAL_COMPUTER_CONTROL_STATE_DIR", "ANTIGRAVITY_AGENT_PYTHON", "ANTIGRAVITY_AGENT_STATE_DIR", "ANTIGRAVITY_AGENT_MAX_CONCURRENT", "ANTIGRAVITY_AGENT_COMPUTER_CONTROL", "AGY_EXECUTABLE", ...local.environment]) {
      if (process.env[name]) env[name] = process.env[name];
      else if (local.defaults[name]) env[name] = local.defaults[name];
    }
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(cwd, "server.js")], cwd, env,
      stderr: "pipe", maxBufferSize: 24 * 1024 * 1024,
    });
    const client = new Client({ name: "local-mcp-gateway", version: VERSION }, { capabilities: {} });
    service.transport = transport;
    client.onclose = () => {
      if (service.client === client) {
        service.client = null;
        service.transport = null;
        service.error = "Local service disconnected. Retry the tool to reconnect; an interrupted task is not automatically re-executed.";
        service.failedAt = Date.now();
        toolCache.invalidate(service.id);
        notifyToolsChanged();
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {toolCache.invalidate(service.id);notifyToolsChanged();});
    try {
      await client.connect(transport, { timeout: 20000 });
      transport.stderr?.on('data', chunk => process.stderr.write(safeError(chunk.toString())));
      if (stopping) throw new Error("Gateway is shutting down.");
      service.client = client;
      service.error = null;
      service.failedAt = 0;
      return client;
    } catch (error) {
      service.error = safeError(error);
      service.failedAt = Date.now();
      await client.close().catch(() => {});
      if (service.transport === transport) service.transport = null;
      throw error;
    }
  })().finally(() => { service.connecting = null; });
  return service.connecting;
}

async function collectTools() {
  const results = await Promise.allSettled(services.map(async (service) => {
    const client = await connection(service);
    return toolCache.get(service.id, async () => {
    const items = [];
    let cursor;
    const seen = new Set();
    do {
      const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20000 });
      items.push(...response.tools);
      cursor = response.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("Backend returned a repeated discovery cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return validateToolList(items, service.tools);
    });
  }));
  const unavailable = [];
  const items = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      if (services[index].client) { services[index].error = null; services[index].failedAt = 0; }
    }
    else {
      services[index].error = safeError(result.reason);
      unavailable.push({ service: services[index].id, error: services[index].error });
    }
  });
  return { tools: [statusTool, ...items],
    ...(unavailable.length ? { _meta: { unavailable_services: unavailable } } : {}) };
}

server.setRequestHandler(ListToolsRequestSchema, collectTools);
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === statusTool.name) {
    const value = { tunnel_entry: "local-mcp-gateway",
      deployment: await workspaceStatus(path.resolve(root, '..'), { verifyFiles: request.params.arguments?.verify_integrity === true, verifyDependencyFiles: request.params.arguments?.verify_dependencies === true }),
      ...(request.params.arguments?.diagnose_environment ? {environment:await environmentDiagnostics(path.resolve(root,'..'))}:{}),
      ...(request.params.arguments?.storage_inventory ? {storage:await storageInventory(path.resolve(root,'..'))}:{}),
      services: services.map((service) => ({
      service: service.id, connected: Boolean(service.client), connecting: Boolean(service.connecting),
      state: service.client ? "connected" : service.connecting ? "connecting" : service.error ? "unavailable" : "not_started",
      error: service.error, independent: true,
    })) };
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  }
  const owner = toolOwners.get(request.params.name);
  let dispatched = false;
  try {
    if (!owner) throw new Error(`Unknown tool: ${request.params.name}`);
    // Forward once. Never automatically retry mutating tools.
    const client = await connection(owner);
    dispatched = true;
    const result = await client.callTool(request.params, undefined, { timeout: 120000, signal: extra.signal });
    return result.isError ? redactSecrets(result) : result;
  } catch (error) {
    const value = { code: "GATEWAY_FORWARD_FAILED", service: owner?.id || null, error: safeError(error),
      next_action: "Inspect get_gateway_status and saved operation state before any new submission." };
    if (['write_local_file','edit_local_file','run_local_command','edit_local_document','cancel_local_execution','computer_action','acquire_computer_control','release_computer_control'].includes(request.params.name)) Object.assign(value, forwardingFailure(request.params.name,dispatched));
    if (owner?.mutating_tools?.includes(request.params.name)) {
      Object.assign(value, forwardingFailure(request.params.name, dispatched));
      for (const key of ['request_id', 'task_id']) {
        if (request.params.arguments?.[key]) value[key] = request.params.arguments[key];
      }
      if (owner.recovery_guidance) value.next_action = owner.recovery_guidance;
    }
    if (owner?.id === 'files' && ['run_local_command', 'edit_local_document', 'cancel_local_execution'].includes(request.params.name)) {
      Object.assign(value, { execution_state: dispatched ? 'execution_unknown' : 'not_executed', action_not_retried: true,
        request_id: request.params.arguments?.request_id || null, execution_id: request.params.arguments?.execution_id || null,
        next_action: 'Query get_local_execution with the original request_id/execution_id before making any new submission. The gateway never replays local commands or document edits.' });
    }
    if (owner?.id === 'files' && ['write_local_file', 'edit_local_file'].includes(request.params.name)) {
      Object.assign(value, { execution_state: dispatched ? 'execution_unknown' : 'not_executed', action_not_retried: true,
        path: request.params.arguments?.path,
        next_action: dispatched ? 'The write reply was lost. Inspect the current file and SHA256 before deciding what remains; do not automatically replay the write.' : 'The backend was unavailable before forwarding. Inspect get_gateway_status before retrying.' });
    }
    return { isError: true, content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  }
});

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled(services.map(async (service) => {
    await service.connecting?.catch(() => {});
    if (service.client) await service.client.close();
    else if (service.transport) await service.transport.close();
  }));
  await server.close().catch(() => {});
}
const transport = new StdioServerTransport();
server.onclose = () => { void stop(); };
process.stdin.once("end", () => { void stop(); });
process.stdin.once("close", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
server.connect(transport).catch(async (error) => {
  process.stderr.write(`local-mcp-gateway startup failed: ${safeError(error)}\n`);
  await stop();
  process.exitCode = 1;
});
