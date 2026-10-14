import { stateDirectory } from '../shared/runtime-paths.js';
import { spawn } from 'node:child_process';
import { open, readFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { BROKER_VERSION, BROKER_PROTOCOL, supportsBroker, newerBroker } from './broker-version.js';

const root = path.dirname(fileURLToPath(import.meta.url));
export const stateRoot = () => process.env.LOCAL_COMPUTER_CONTROL_STATE_DIR || stateDirectory('local-computer-control');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async name => {
  try { return JSON.parse(await readFile(path.join(stateRoot(), name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const endpoint = info => Number.isInteger(info?.port) && info.port > 0 && info.port <= 65535 && typeof info.token === 'string';
const headers = info => ({ Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' });
let cachedBroker = null, brokerPending = null;
const remember = info => { cachedBroker = { root: stateRoot(), info, at: Date.now() }; return info; };
export const invalidateBroker = () => { cachedBroker = null; };

export function cleanEnvironment() {
  const env = { ...process.env };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.LOCAL_COMPUTER_CONTROL_LAUNCHER;
  delete env.LOCAL_COMPUTER_CONTROL_OWNER_ID;
  return env;
}
async function health(info) {
  if (!endpoint(info)) return null;
  try {
    const response = await fetch('http://127.0.0.1:' + info.port + '/health',
      { headers: headers(info), signal: AbortSignal.timeout(1200) });
    const value = await response.json();
    return response.ok && value.instance_id === info.instance_id ? value : null;
  } catch { return null; }
}
async function call(info, operation, input, options = {}) {
  const response = await fetch('http://127.0.0.1:' + info.port + '/call', {
    method: 'POST', headers: headers(info), body: JSON.stringify({ operation, input }),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout || 55000)])
      : AbortSignal.timeout(options.timeout || 55000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Computer service HTTP ' + response.status);
  return value;
}
const current = (info, value) => value && !value.retiring && value.protocol === BROKER_PROTOCOL &&
  (value.version === BROKER_VERSION || newerBroker(value.version))
  ? { ...info, broker_version: value.version, ...(newerBroker(value.version) ? { client_update_pending: true } : {}) } : null;

async function startupLock(action) {
  const config = await read('runtime.json');
  if (!config?.python) throw new Error('Computer control runtime is not installed at ' + path.join(stateRoot(), 'runtime.json') + '. Run local-computer-control/scripts/setup.ps1.');
  const helper = spawn(config.helper_python || config.python, [path.join(root, 'broker-lock.py'), path.join(stateRoot(), 'startup.guard'), '15'],
    { env: cleanEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errorText = '';
  helper.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
  helper.stdin.on('error', () => {});
  const closed = new Promise(resolve => helper.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => { helper.kill(); reject(new Error('Computer service startup lock timed out.')); }, 18000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.stdout.on('data', chunk => { data += chunk; if (data.includes('LOCKED\n') || data.includes('LOCKED\r\n')) { clearTimeout(timer); resolve(); } });
      helper.once('close', () => { clearTimeout(timer); reject(new Error(errorText.trim() || 'Computer service startup lock stopped.')); });
    });
    return await action();
  } finally { helper.stdin.end(); await closed; }
}

async function launcherHealthy(candidate) {
  if (!endpoint(candidate) || !alive(candidate.pid) || typeof candidate.instance_id !== 'string') return false;
  try {
    const response = await fetch('http://127.0.0.1:' + candidate.port + '/health',
      { headers: headers(candidate), signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    return response.ok && value.instance_id === candidate.instance_id && value.pid === candidate.pid && value.protocol === 1;
  } catch { return false; }
}
async function activateParent() {
  const candidates = [];
  if (process.env.LOCAL_COMPUTER_CONTROL_LAUNCHER) {
    const explicit = JSON.parse(process.env.LOCAL_COMPUTER_CONTROL_LAUNCHER);
    if (explicit.unavailable) throw new Error('Desktop launcher initialization failed for this task; file/CLI work remains available.');
    candidates.push(explicit);
  }
  const directory = path.join(stateRoot(), 'launchers');
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(name => /^\d+-[0-9a-f]{16}\.json$/.test(name)).slice(0, 64)) {
    const file = path.join(directory, name);
    const candidate = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (!Number.isInteger(candidate?.pid)) continue;
    if (!alive(candidate.pid)) { await rm(file, { force: true }).catch(() => {}); continue; }
    candidates.push(candidate);
  }
  candidates.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.instance_id)) continue;
    seen.add(candidate.instance_id);
    if (!await launcherHealthy(candidate)) continue;
    try {
      const response = await fetch('http://127.0.0.1:' + candidate.port + '/start',
        { method: 'POST', headers: headers(candidate), signal: AbortSignal.timeout(20000) });
      if (!response.ok) continue;
      const activation = await response.json(), info = await read('broker.json'), value = await health(info);
      if (value && value.instance_id === activation.instance_id && !value.retiring && supportsBroker(value)) {
        const ready = current(info, value);
        if (ready) return ready;
        return { ...info, broker_version: value.version, ...(value.version === BROKER_VERSION ? {} : { upgrade_pending: true, required_version: BROKER_VERSION }) };
      }
    } catch { /* Try another verified parent; no desktop operation was issued. */ }
  }
  if (process.env.LOCAL_COMPUTER_CONTROL_OWNER_ID || process.env.LOCAL_COMPUTER_CONTROL_LAUNCHER) {
    throw new Error('No verified desktop parent launcher is available; the shared Broker was not started inside the task.');
  }
  return null;
}

async function connectBroker(options) {
  let info = await read('broker.json'), value = await health(info);
  const existing = current(info, value);
  if (existing) return existing;
  if (!options.parent) {
    const activated = await activateParent();
    if (activated) return activated;
  }
  await mkdir(stateRoot(), { recursive: true });
  return startupLock(async () => {
    info = await read('broker.json'); value = await health(info);
    const reused = current(info, value);
    if (reused) return reused;
    if (value) {
      if (!supportsBroker(value)) throw new Error('Desktop Broker protocol is incompatible; no second Broker was started.');
      if (!value.retiring) {
        const shutdown = await call(info, 'shutdown', {}, { timeout: 4000 });
        const result = shutdown.structuredContent;
        if (result?.code === 'DESKTOP_BUSY') return { ...info, broker_version: value.version,
          upgrade_pending: true, required_version: BROKER_VERSION, upgrade_reason: 'DESKTOP_BUSY' };
        if (!result?.stopped) throw new Error('Desktop Broker declined a safe upgrade; no second Broker was started.');
      }
      const deadline = Date.now() + 6000;
      // Wait for the old instance to finish cleanup and unregister itself.
      while (Date.now() < deadline) {
        const registered = await read('broker.json');
        if (!await health(info) && registered?.instance_id !== info.instance_id) break;
        await pause(80);
      }
      if (await health(info) || (await read('broker.json'))?.instance_id === info.instance_id) {
        throw new Error('Desktop Broker upgrade is waiting for shutdown; no second Broker was started.');
      }
      info = await read('broker.json'); value = await health(info);
      if (current(info, value)) return current(info, value);
      if (value) throw new Error('Desktop Broker registration changed during upgrade; inspect status before retrying.');
    }
    if (alive(info?.pid)) throw new Error('Registered desktop Broker is alive but its identity cannot be verified; no second Broker was started.');
    const log = await open(path.join(stateRoot(), 'broker.log'), 'a');
    let launchError;
    try {
      const child = spawn(process.execPath, [path.join(root, 'broker.js')], {
        cwd: root, env: cleanEnvironment(), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
      });
      child.once('error', error => { launchError = error; }); child.unref();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        info = await read('broker.json');
        const ready = current(info, await health(info));
        if (ready) return ready;
        await pause(100);
      }
      throw new Error('Shared computer service did not become ready; inspect its broker.log.');
    } finally { await log.close(); }
  });
}

export async function ensureBroker(options = {}) {
  if (cachedBroker?.root === stateRoot() && Date.now() - cachedBroker.at < 2000) return cachedBroker.info;
  if (!brokerPending) brokerPending = connectBroker(options).then(remember).finally(() => { brokerPending = null; });
  return brokerPending;
}
export async function computerRequest(operation, input = {}, options = {}) {
  const info = options.start === false ? cachedBroker?.root === stateRoot() && Date.now() - cachedBroker.at < 2000
    ? cachedBroker.info : await read('broker.json') : await ensureBroker();
  if (!info) return null;
  try {
    const value = await call(info, operation, input, options);
    if (operation === 'get_computer_status' && value.structuredContent && info.upgrade_pending) {
      value.structuredContent = { ...value.structuredContent, upgrade_pending: true, required_version: BROKER_VERSION,
        upgrade_reason: info.upgrade_reason || 'DESKTOP_BUSY' };
      value.content = [{ type: 'text', text: JSON.stringify(value.structuredContent) }];
    }
    if (operation === 'get_computer_status' && value.structuredContent && info.client_update_pending) {
      value.structuredContent = { ...value.structuredContent, client_update_pending: true, client_version: BROKER_VERSION };
      value.content = [{ type: 'text', text: JSON.stringify(value.structuredContent) }];
    }
    return value;
  } catch (error) { invalidateBroker(); throw error; } // Never replay an uncertain action.
}
