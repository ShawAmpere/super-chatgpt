import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stateRoot } from './service-client.js';
import { DesktopLease } from './desktop-lease.js';
import { desktopAction } from './action-map.js';
import { validateInput } from './tools.js';
import { JsonLineWorker } from '../shared/json-line-worker.js';
import { BROKER_VERSION, BROKER_PROTOCOL } from './broker-version.js';
import { OperationMetrics } from './operation-metrics.js';
import { waitResult } from './wait-result.js';
import { captureFailed, normalizeDesktopContent, snapshotIdentity, captureDiagnostic, actionResult } from './desktop-result.js';
import { DesktopLane, DesktopObservation, DesktopRequestError } from './desktop-state.js';
import { performance } from 'node:perf_hooks';

const instanceId = randomUUID(), token = randomBytes(32).toString('hex');
const config = JSON.parse(await readFile(path.join(stateRoot(), 'runtime.json'), 'utf8'));
const lease = new DesktopLease();
let backend = null, backendTransport = null, backendPending = null, backendError = null;
let stopping = false, retiring = false, lastActivity = Date.now(), idle;
const strictLabels = process.env.LOCAL_COMPUTER_CONTROL_REQUIRE_LABEL_SNAPSHOT !== '0';
const lane = new DesktopLane(lease), observation = new DesktopObservation(undefined, strictLabels);
const metrics = new OperationMetrics();
const result = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const metadataWorker = new JsonLineWorker(config.python, [fileURLToPath(new URL('./desktop-metadata.py',import.meta.url)), '--serve'], {env:getDefaultEnvironment()});

async function engine() {
  if (backend) return backend;
  if (backendPending) return backendPending;
  backendPending = (async () => {
    await access(config.python);
    const env = { ...getDefaultEnvironment(), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      ANONYMIZED_TELEMETRY: 'false', POSTHOG_API_KEY: '', WINDOWS_MCP_SCREENSHOT_BACKEND: 'pillow',
      WINDOWS_MCP_TOOLS: 'Screenshot,Snapshot,Click,Type,Scroll,Move,Shortcut,App,Clipboard,WaitFor,ControlStatus',
      WINDOWS_MCP_SCREENSHOT_SCALE: '1.0' };
    const transport = new StdioClientTransport({ command: config.python,
      args: [fileURLToPath(new URL('./desktop-backend.py',import.meta.url)), 'serve', ...(config.backend_config ? ['--config', config.backend_config] : [])], env,
      stderr: 'pipe', maxBufferSize: 24 * 1024 * 1024 });
    const client = new Client({ name: 'local-computer-broker', version: BROKER_VERSION });
    transport.stderr?.on('data', (chunk) => { process.stderr.write(String(chunk).replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')); });
    client.onclose = () => { if (backend === client) { backend = null; backendTransport = null; observation.invalidate('backend_disconnected'); } };
    try {
      await client.connect(transport, { timeout: 15000 });
      const names = new Set((await client.listTools(undefined, { timeout: 10000 })).tools.map((tool) => tool.name));
      for (const name of ['Screenshot','Snapshot','Click','Type','Scroll','Move','Shortcut','App','Clipboard','WaitFor']) {
        if (!names.has(name)) throw new Error(`Windows-MCP is missing required tool ${name}`);
      }
      backend = client; backendTransport = transport; backendError = null;
      return client;
    } catch (error) {
      backendError = error.message;
      await client.close().catch(() => {});
      throw error;
    }
  })().finally(() => { backendPending = null; });
  return backendPending;
}

async function desktopCall(owner, name, args, timeout = 25000, signal) {
  let sent = false;
  try {
    signal?.throwIfAborted();
    lease.require(owner);
    const client = await engine();
    signal?.throwIfAborted();
    sent = true;
    const value = normalizeDesktopContent(await client.callTool({ name, arguments: args }, undefined, { timeout, signal }));
    if (captureFailed(value)) {
      value.isError = true;
      const diagnostic = captureDiagnostic(value);
      if (diagnostic) value.structuredContent = { ...(value.structuredContent || {}), ...diagnostic };
    }
    if(name==='WaitFor'&&waitResult(value)?.status==='probe_timeout'){
      // A read-only provider can outlive its deadline. Stop it before the next
      // desktop operation enters this lane; do not claim the target was absent.
      backend=null;backendTransport=null;observation.invalidate('wait_probe_timeout');
      await client.close().catch(()=>{});
      backendError='UI inspection exceeded the requested wait deadline.';
    }
    return value;
  } catch (error) {
    observation.invalidateAfterUncertainCall(name, sent);
    if (signal?.aborted || /timed? out|request timeout/i.test(error.message)) {
      // A timed-out UI action may still be running. End its backend before releasing the queue.
      const client = backend;
      backend = null; backendTransport = null; observation.invalidate('backend_timeout_or_cancelled');
      await client?.close().catch(() => {});
      backendError = 'Desktop operation timed out or was cancelled; inspect before retrying any action.';
    }
    if (['Click','Type','Scroll','Move','Shortcut','App','Clipboard'].includes(name)) {
      error.details = {code:'DESKTOP_CALL_FAILED', error:error.message, execution_state:sent?'execution_unknown':'not_executed',
        action_not_executed:!sent, action_not_retried:true, next_action:sent?'Inspect the desktop before deciding what remains; do not replay.':'Resolve the service error before retrying.'};
    }
    throw error;
  }
}

async function windowMetadata() {
  return (await metadataWorker.request({operation:'metadata'},2000)).value;
}
function attachObservation(value) {
  const state = observation.describe();
  value.structuredContent = { ...(value.structuredContent || {}), observation: state };
  value.content.push({ type:'text', text:'Desktop observation: ' + JSON.stringify(state) });
  return value;
}

async function dispatch(operation, input, signal) {
  lastActivity = Date.now();
  if (retiring || stopping) return result({ code: 'BROKER_RETIRING', error: 'The idle desktop service is switching versions; inspect status before retrying.' }, true);
  if (operation === 'shutdown') {
    if (lease.status().busy || lease.inFlight) return result({ stopped: false, code: 'DESKTOP_BUSY' });
    // Gate new acquisitions immediately, before yielding to the response/close.
    retiring = true;
    setTimeout(() => { void stop(); }, 50);
    return result({ stopped: true });
  }
  input = validateInput(operation, input);
  const owner = input.owner_id;
  if (operation === 'get_computer_status') {
    let userControl = null;
    if (backend) {
      try { userControl = (await backend.callTool({ name: 'ControlStatus', arguments: {} }, undefined, { timeout: 3000 })).structuredContent || null; }
      catch { /* The existing backend readiness error is reported below. */ }
    }
    return result({ service: 'local-computer-control', version: BROKER_VERSION, protocol: BROKER_PROTOCOL,
    backend: 'Windows-MCP', backend_version: config.backend_version, backend_connected: Boolean(backend),
    backend_error: backendError, desktop: lease.status(), user_control: userControl,
    shared_by: ['Chat', 'authorized local workflows'], require_label_snapshot_id: strictLabels, observation: { ...observation.describe(), owner_id: null },
    performance: metrics.summary(), coordinate_system: 'original Windows desktop pixels; use the returned screenshot scale and region when mapping image coordinates' });
  }
  if (!owner) throw new Error('owner_id is required for this desktop workflow. First call acquire_computer_control.');
  if (operation === 'acquire_computer_control') {
    const deadline = Date.now() + input.wait_seconds * 1000;
    let value;
    do {
      signal?.throwIfAborted();
      if (retiring || stopping) return result({ acquired: false, code: 'BROKER_RETIRING' });
      value = lease.acquire(owner, input.lease_seconds);
      if (value.acquired || Date.now() >= deadline) break;
      await pause(Math.min(200, deadline - Date.now()));
    } while (true);
    return result(value);
  }
  if (operation === 'release_computer_control') {
    const value = lease.release(owner);
    if (value.released && observation.last?.owner_id === owner) observation.invalidate('lease_released');
    return result(value);
  }
  lease.require(owner);
  return lane.run(owner,()=>desktopDispatch(operation,input,signal),signal);
}

async function desktopDispatch(operation,input,signal) {
  const owner = input.owner_id;
  if (operation === 'computer_snapshot') {
    observation.invalidate('capture_started');
    const args = { use_annotation: false, ...(input.display ? { display: input.display } : {}), ...(input.region ? { region: input.region } : {}) };
    const value = input.detail === 'screenshot' ? await desktopCall(owner, 'Screenshot', args, 25000, signal)
      : await desktopCall(owner, 'Snapshot', { ...args, use_vision: input.detail === 'both', use_ui_tree: true,scope:input.scope,...(input.window_name?{window_name:input.window_name}:{}) }, 25000, signal);
    if (!value.isError) {
      let foreground = snapshotIdentity(value);
      try {
        const metadata = await windowMetadata();
        foreground ||= metadata.focused_window;
        if (input.detail === 'screenshot') {
          value.content.push({ type: 'text', text: `Fast Win32 window metadata: ${JSON.stringify(metadata)}` });
        }
      } catch { value.content.push({ type: 'text', text: 'Fast window metadata unavailable; input will require a verified foreground window.' }); }
      observation.record(owner,input.detail,foreground,input.detail === 'screenshot' ? null : snapshotIdentity(value,'Control tree target identity: '));
    } else observation.invalidate('capture_failed');
    return attachObservation(value);
  }
  if (operation === 'computer_action') {
    const [name, args] = desktopAction(input);
    if (!['launch','focus','resize','clipboard_get','clipboard_set'].includes(input.action)) {
      observation.require(owner,input.label,input.snapshot_id);
      let metadata;
      try { metadata = await windowMetadata(); }
      catch { throw new DesktopRequestError('DESKTOP_INSPECTION_UNAVAILABLE','Could not verify the foreground window before input. Take another snapshot.'); }
      observation.checkForeground(metadata.focused_window);
      observation.require(owner,input.label,input.snapshot_id);
    }
    const value = actionResult(await desktopCall(owner, name, args, 25000, signal));
    // Element labels and the selected window must be re-observed after a mutating action.
    if(!['clipboard_get','clipboard_set'].includes(input.action) && value.structuredContent.execution_state!=='not_executed')observation.invalidate('action_performed');
    if(input.observe_after!=='none'&&!value.isError){
      let captured;
      try {
        captured=await desktopDispatch('computer_snapshot',{owner_id:owner,detail:input.observe_after,scope:'active',...(input.observe_region?{region:input.observe_region}:{})},signal);
      } catch(error) {
        captured=result({code:'OBSERVATION_FAILED',error:error.message,action_not_retried:true},true);
      }
      value.content.push({type:'text',text:'Post-action observation (the action was not replayed):'},...captured.content);
      value.structuredContent={...(value.structuredContent||{}),action_acknowledged:true,observation_completed:!captured.isError};
      if(captured.isError)value.isError=true;
    }
    return attachObservation(value);
  }
  if (operation === 'computer_wait_for') {
    const value = await desktopCall(owner, 'WaitFor', {
      condition: input.condition, ...(input.text ? { text: input.text } : {}), ...(input.window_name ? { window_name: input.window_name } : {}), timeout: input.timeout, interval: 0.3,
    }, input.timeout * 1000 + 10000, signal);
    const condition=waitResult(value);
    if(input.condition==='active_window' && condition && condition.status!=='probe_timeout' && !value.isError) {
      if(observation.last && !observation.reason) {
        try { observation.checkForeground((await windowMetadata()).focused_window); }
        catch { observation.invalidate('foreground_verification_failed'); }
      }
    } else observation.invalidate('ui_wait_replaced_element_state');
    if(condition){return attachObservation(result(condition,condition.status==='probe_timeout'));}
    return attachObservation(value);
  }
  throw new Error(`Unknown computer operation ${operation}`);
}

function authorized(request) {
  const provided = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
const server = http.createServer(async (request, response) => {
  let measurement=null;
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!authorized(request)) { response.writeHead(401); response.end(JSON.stringify({ error: 'Unauthorized' })); return; }
  try {
    if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ instance_id: instanceId, version: BROKER_VERSION, protocol: BROKER_PROTOCOL, retiring: retiring || stopping })); return; }
    if (request.method !== 'POST' || request.url !== '/call' || stopping) { response.writeHead(404); response.end('{}'); return; }
    let body = '', bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Desktop request exceeds one MiB.'); body += chunk; }
    const { operation, input } = JSON.parse(body);
    const started=performance.now();
    measurement={operation,started,...(input?.action?{action:input.action}:{}),...(input?.detail?{detail:input.detail}:{}),...(input?.condition?{condition:input.condition}:{})};
    const value=await dispatch(operation,input||{},controller.signal);
    const {started:measurementStarted,...fields}=measurement;
    const timing={...fields,elapsed_ms:Math.round((performance.now()-measurementStarted)*100)/100,is_error:Boolean(value.isError)};
    metrics.record(timing);
    measurement=null;
    value._meta={...(value._meta||{}),local_timing:timing};
    response.end(JSON.stringify(value));
  } catch (error) {
    const value = error.details || { error: String(error.message), code: /DESKTOP_BUSY/.test(error.message) ? 'DESKTOP_BUSY' : 'COMPUTER_REQUEST_FAILED' };
    if(measurement){const {started,...fields}=measurement;metrics.record({...fields,elapsed_ms:Math.round((performance.now()-started)*100)/100,is_error:true});}
    response.end(JSON.stringify(result(value, true)));
  }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const infoFile = path.join(stateRoot(), 'broker.json');
const tempFile = `${infoFile}.${process.pid}.tmp`;
await writeFile(tempFile, JSON.stringify({ instance_id: instanceId, pid: process.pid, port: server.address().port, token, version: BROKER_VERSION, protocol: BROKER_PROTOCOL }), { mode: 0o600 });
await rename(tempFile, infoFile);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(idle);
  await backendPending?.catch(() => {});
  await backend?.close().catch(() => {});
  backend = null;
  await metadataWorker.close();
  server.closeIdleConnections();
  await new Promise((resolve) => server.close(resolve));
  const saved = JSON.parse(await readFile(infoFile, 'utf8').catch(() => '{}'));
  if (saved.instance_id === instanceId) await rm(infoFile, { force: true });
}
idle = setInterval(() => { if (!lease.status().busy && !lease.inFlight && Date.now() - lastActivity > 15 * 60 * 1000) void stop(); }, 60000);
idle.unref();
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
