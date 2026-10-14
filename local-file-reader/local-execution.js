import { stateDirectory } from '../shared/runtime-paths.js';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, watch } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { basePython, editorPython, editorScript, editorFormats } from './editor-runtime.js';
import { writeLocalFile } from './file-write.js';

export const executionLimits = { concurrent: 4, output_bytes: 4 * 1024 * 1024, code_chars: 131072, wait_seconds: 20,
  timeout_seconds: 3600, document_job_memory_mib: 1024, document_output_mib: 64 };
const active = new Map();
const support = fileURLToPath(new URL('./process-support.py', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const root = () => path.join(process.env.LOCAL_FILE_READER_STATE_DIR || stateDirectory('local-file-reader'), 'executions');
const idFor = request => { const hex = digest(request).slice(0, 32).split(''); hex[12] = '5'; hex[16] = '8';
  return hex.join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const keyFor = id => path.join(root(), id);
const terminal = record => !['starting', 'running', 'finishing'].includes(record.status);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function save(directory, record) {
  const temporary = path.join(directory, 'record-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path.join(directory, 'record.json')); }
  finally { await unlink(temporary).catch(() => {}); }
}
async function readRecord(directory) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return JSON.parse(await readFile(path.join(directory, 'record.json'), 'utf8')); }
    catch (error) { if (attempt === 5 || !(error.code === 'ENOENT' || error instanceof SyntaxError)) throw error; await sleep(50); }
  }
}
async function slot(directory) {
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < executionLimits.concurrent; index++) {
    const file = path.join(directory, `slot-${index}.json`), token = randomUUID();
    try { await writeFile(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); return { file, token }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
      if (previous && Number.isSafeInteger(previous.pid) && previous.pid > 0 && !alive(previous.pid)) { await unlink(file).catch(() => {}); index--; }
    }
  }
  fail('EXECUTION_BUSY', 'Four local executions are active. Wait for or cancel an existing execution before submitting another.');
}
async function releaseSlot(guard) {
  if (!guard) return;
  const value = await readFile(guard.file, 'utf8').then(JSON.parse).catch(() => null);
  if (value?.token === guard.token) await unlink(guard.file);
}
function environment() {
  const result = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  for (const name of Object.keys(result)) if (/CONTROL_PLANE|TUNNEL.*(?:KEY|TOKEN)|LOCAL_PROCESS_CONTROL_FILE|PROCESS_JOB_MEMORY_LIMIT/.test(name)) delete result[name];
  return result;
}
function identifier({ execution_id, request_id }) {
  if (!execution_id && !request_id) fail('EXECUTION_ID_REQUIRED', 'Provide execution_id or the original request_id.');
  const id = execution_id || idFor(request_id);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) fail('INVALID_EXECUTION_ID', 'Use the execution ID returned by the submission.');
  if (request_id && id !== idFor(request_id)) fail('EXECUTION_ID_MISMATCH', 'execution_id and request_id name different executions.');
  return id;
}
async function cwdOf(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INVALID_CWD', 'cwd must be an absolute existing local directory.');
  const result = await realpath(input);
  if (!(await lstat(result)).isDirectory()) fail('INVALID_CWD', 'cwd must be a directory.');
  return result;
}

async function begin(spec, prepare) {
  if (!spec.request_id || spec.request_id.length < 8 || spec.request_id.length > 200) fail('REQUEST_ID_REQUIRED', 'Use a unique request_id of 8–200 characters. Reuse it only to recover the same submission.');
  const id = idFor(spec.request_id), directory = keyFor(id), fingerprint = digest(JSON.stringify(spec));
  const cached = active.get(directory);
  if (cached?.record.fingerprint === fingerprint) return { ...await getLocalExecution({ execution_id: id }), recovered_submission: true };
  if ([...active.values()].some(entry => entry.record.state_persisted === false)) fail('STATE_STORAGE_ERROR', 'A finished execution has unsaved state. Save its visible output, repair the state directory and query it again before submitting more work.');
  await mkdir(root(), { recursive: true });
  try { await mkdir(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = await readRecord(directory).catch(() => fail('EXECUTION_CLAIM_INCOMPLETE', 'A submission claim has no readable record. Inspect its directory; it is not automatically executed again.'));
    if (old.fingerprint !== fingerprint) fail('REQUEST_ID_CONFLICT', 'This request_id was already used with different parameters.');
    return { ...(await getLocalExecution({ execution_id: id, wait_seconds: spec.wait_seconds })), recovered_submission: true };
  }
  const entry = { directory, record: { execution_id: id, request_id: spec.request_id, fingerprint, kind: spec.kind,
    status: 'starting', owner_pid: process.pid, created_at: new Date().toISOString(), cwd: spec.cwd,
    execution_state: 'not_executed', ...(spec.path ? { path: spec.path, target_state: 'not_published' } : {}) },
    stdout: '', stderr: '', outputBytes: 0 };
  active.set(directory, entry);
  entry.done = new Promise(resolve => { entry.resolve = resolve; });
  try { await save(directory, entry.record); }
  catch (error) { active.delete(directory); entry.resolve(); error.details = { execution_id: id, execution_state: 'not_executed' }; throw error; }
  void drive(entry, spec, prepare);
  return getLocalExecution({ execution_id: id, wait_seconds: spec.wait_seconds });
}

async function drive(entry, spec, prepare) {
  let timer, checker, watcher, guard, cleanup, logs = [];
  try {
    guard = await slot(root());
    const invocation = await prepare(entry.directory);
    cleanup = invocation.cleanup;
    if (entry.cancelRequested || await access(path.join(entry.directory, 'cancel')).then(() => true, () => false)) {
      entry.record.status = 'cancelled'; return;
    }
    logs = ['stdout', 'stderr'].map(name => createWriteStream(path.join(entry.directory, name + '.log'), { flags: 'wx' }));
    let logFailure;
    logs.forEach(log => log.on('error', error => { logFailure = error; entry.child?.kill(); }));
    const child = spawn(basePython(), [support, 'supervise', ...invocation.command], {
      cwd: spec.cwd, env: { ...environment(), ...(spec.kind === 'document' ? { PROCESS_JOB_MEMORY_LIMIT: String(1024 ** 3) } : {}) },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    entry.child = child;
    entry.record.status = 'running'; entry.record.started_at = new Date().toISOString();
    entry.record.execution_state = 'execution_unknown';
    const closed = new Promise(resolve => { child.once('close', (code, signal) => resolve({ code, signal })); });
    entry.closed = closed;
    child.once('error', error => { entry.spawnError = error; entry.record.execution_state = 'not_executed'; });
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    for (const [index, name] of ['stdout', 'stderr'].entries()) {
      child[name].on('data', bytes => {
        const remaining = Math.max(0, executionLimits.output_bytes - entry.outputBytes);
        const accepted = bytes.subarray(0, remaining);
        entry.outputBytes += accepted.length; logs[index].write(accepted); entry[name] += decoders[index].write(accepted);
        if (bytes.length > remaining) { entry.record.output_truncated = true; entry.stopReason ||= 'output_limit'; child.kill(); }
      });
      child[name].once('end', () => { entry[name] += decoders[index].end(); });
    }
    const checkCancel = async () => {
      if (entry.cancelRequested || await access(path.join(entry.directory, 'cancel')).then(() => true, () => false)) {
        entry.stopReason ||= 'cancelled'; child.kill();
      }
    };
    watcher = watch(entry.directory, (_, filename) => { if (filename === 'cancel') void checkCancel().catch(() => {}); });
    checker = setInterval(() => { void checkCancel().catch(() => {}); }, 2000); checker.unref();
    timer = setTimeout(() => { entry.stopReason ||= 'timed_out'; child.kill(); }, spec.timeout_seconds * 1000);
    await save(entry.directory, entry.record);
    const outcome = await closed;
    if (entry.spawnError) throw entry.spawnError;
    clearTimeout(timer); clearInterval(checker); watcher?.close(); watcher = undefined;
    for (const log of logs) log.end();
    await Promise.all(logs.map(log => finished(log))); logs = [];
    if (logFailure) throw logFailure;
    entry.record.exit_code = outcome.code; entry.record.signal = outcome.signal; entry.record.cleanup_confirmed = true;
    entry.record.execution_state = entry.stopReason ? 'execution_unknown' : 'executed';
    entry.record.status = entry.stopReason || (outcome.code === 0 ? 'completed' : 'failed');
    if (entry.record.status === 'completed' && invocation.publish) {
      entry.record.status = 'finishing'; await save(entry.directory, entry.record);
      try { entry.record.document = await invocation.publish(); entry.record.target_state = invocation.preview ? 'preview_only' : 'published'; }
      catch (error) {
        entry.record.error = error.message; entry.record.code = error.code || 'DOCUMENT_PUBLISH_FAILED';
        if (error.details) entry.record.document_error = error.details;
        if (error.details?.execution_state === 'execution_unknown') { entry.record.target_state = 'execution_unknown'; entry.record.execution_state = 'execution_unknown'; }
        entry.record.status = 'failed';
      }
      if (entry.record.status === 'finishing') entry.record.status = 'completed';
    }
  } catch (error) {
    entry.record.status = 'failed'; entry.record.code = error.code || 'EXECUTION_FAILED'; entry.record.error = error.message;
    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
  } finally {
    clearTimeout(timer); clearInterval(checker); watcher?.close();
    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
    await entry.closed;
    for (const log of logs) { log.end(); await finished(log).catch(() => {}); }
    await cleanup?.().catch(error => { entry.record.cleanup_warning = error.message; });
    entry.record.finished_at = new Date().toISOString(); entry.record.success = entry.record.status === 'completed';
    entry.record.action_not_retried = true;
    entry.record.state_persisted = true;
    await save(entry.directory, entry.record).catch(error => { entry.record.state_persisted = false; entry.record.persistence_error = error.message; });
    await releaseSlot(guard).catch(() => {});
    entry.finished = true; entry.resolve(); if (entry.record.state_persisted) active.delete(entry.directory);
  }
}

export async function runLocalCommand(input) {
  const spec = { kind: 'command', request_id: input.request_id, cwd: await cwdOf(input.cwd), language: input.language || 'powershell',
    code: input.code ?? null, executable: input.executable ?? null, args: input.args || [], timeout_seconds: input.timeout_seconds ?? 300 };
  if (spec.language === 'executable' ? !spec.executable || spec.code !== null : !spec.code || spec.executable !== null || spec.args.length) fail('COMMAND_PARAMETERS', 'Use code for powershell/python/javascript; use executable and args for executable mode.');
  if (spec.code?.length > executionLimits.code_chars) fail('CODE_LIMIT', 'Code exceeds 131072 characters.');
  return begin(spec, async directory => {
    const filename = path.join(directory, { powershell: 'command.ps1', python: 'command.py', javascript: 'command.mjs' }[spec.language] || 'unused');
    let command;
    if (spec.language === 'executable') command = [spec.executable, ...spec.args];
    else {
      const code = spec.language === 'powershell' ? '\ufeff$ErrorActionPreference = "Stop"\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n' + spec.code + '\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n' : spec.code;
      await writeFile(filename, code, { flag: 'wx', mode: 0o600 });
      command = spec.language === 'powershell' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filename]
        : [spec.language === 'python' ? await access(editorPython()).then(() => editorPython(), () => basePython()) : process.execPath, filename];
    }
    return { command };
  }).then(async value => input.wait_seconds ? getLocalExecution({ execution_id: value.execution_id, wait_seconds: input.wait_seconds }) : value);
}

async function stableBytes(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 64 * 1024 * 1024) fail('UNSAFE_DOCUMENT', 'Use a regular non-linked document of at most 64 MiB.');
  const bytes = await readFile(file), after = await lstat(file);
  if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail('FILE_CHANGED', 'Input changed while being copied.');
  return bytes;
}
export async function editLocalDocument(input) {
  if (!path.isAbsolute(input.path)) fail('INVALID_PATH', 'Use an absolute output document path.');
  const spec = { kind: 'document', request_id: input.request_id, cwd: await cwdOf(input.cwd || path.dirname(input.path)),
    path: path.resolve(input.path), source_path: input.source_path ? path.resolve(input.source_path) : null, mode: input.mode || 'create',
    expected_sha256: input.expected_sha256?.toLowerCase() || null, code: input.code, preview_only: input.preview_only === true,
    timeout_seconds: input.timeout_seconds ?? 120 };
  if (input.source_path && !path.isAbsolute(input.source_path)) fail('INVALID_PATH', 'source_path must be absolute.');
  if (!editorFormats.includes(path.extname(spec.path).toLowerCase())) fail('DOCUMENT_FORMAT_UNSUPPORTED', 'Use get_reader_capabilities for the document output formats, or the existing text writer for other text extensions.');
  if (!spec.code || spec.code.length > executionLimits.code_chars) fail('CODE_LIMIT', 'Provide Python code of at most 131072 characters.');
  if (spec.mode === 'replace' && !/^[a-f0-9]{64}$/.test(spec.expected_sha256 || '')) fail('HASH_REQUIRED', 'Replacing a document requires expected_sha256.');
  return begin(spec, async directory => {
    await access(editorPython()).catch(() => fail('DOCUMENT_EDITOR_MISSING', 'Run local-file-reader/scripts/setup-editor.ps1 before document editing. Text and command tools remain usable.'));
    const current = await stableBytes(spec.path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (spec.mode === 'create' && current) fail('FILE_EXISTS', 'Create mode never overwrites a document.');
    if (spec.mode === 'replace' && (!current || digest(current) !== spec.expected_sha256)) fail('FILE_CHANGED', 'The document no longer matches the hash you inspected.');
    let inputPath = null;
    const source = spec.source_path ? await stableBytes(spec.source_path) : current;
    if (source) { inputPath = path.join(directory, 'input' + path.extname(spec.source_path || spec.path)); await writeFile(inputPath, source, { flag: 'wx', mode: 0o600 }); }
    const outputPath = path.join(directory, 'output' + path.extname(spec.path).toLowerCase());
    const config = path.join(directory, 'document.json');
    // Short profiles avoid LibreOffice's Windows path-depth limit. They are
    // owned by this job and cleaned after its supervised process exits.
    const converterWork = await mkdtemp(path.join(os.tmpdir(), 'mcp-lo-'));
    const cleanup = async () => {
      if (!converterWork.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
          (await realpath(converterWork)).toLowerCase() !== converterWork.toLowerCase() || (await lstat(converterWork)).isSymbolicLink()) {
        throw new Error('Converter temporary directory changed identity; automatic cleanup refused.');
      }
      await rm(converterWork, { recursive: true, force: true });
    };
    try {
      await writeFile(config, JSON.stringify({ input_path: inputPath, output_path: outputPath, converter_work_dir: converterWork }), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(directory, 'user-code.py'), spec.code, { flag: 'wx', mode: 0o600 });
    } catch (error) { await cleanup().catch(() => {}); throw error; }
    return { command: [editorPython(), editorScript, config], preview: spec.preview_only, cleanup, publish: async () => {
      const validation = JSON.parse(await readFile(path.join(directory, 'validated.json'), 'utf8'));
      const result = spec.preview_only ? { path: outputPath, sha256: digest(await stableBytes(outputPath)), execution_state: 'not_executed' }
        : await writeLocalFile({ path: spec.path, mode: spec.mode, expected_sha256: spec.expected_sha256, source_path: outputPath });
      return { ...result, validation, visual_layout_verified: false };
    } };
  }).then(async value => input.wait_seconds ? getLocalExecution({ execution_id: value.execution_id, wait_seconds: input.wait_seconds }) : value);
}

export async function getLocalExecution(input) {
  const id = identifier(input), directory = keyFor(id);
  let record = active.get(directory)?.record || await readRecord(directory);
  if (active.get(directory)?.finished && terminal(record) && record.state_persisted === false) {
    try { const repaired = { ...record, state_persisted: true }; delete repaired.persistence_error;
      await save(directory, repaired); record = repaired; active.delete(directory); }
    catch { /* Preserve confirmed in-memory output until storage is repaired. */ }
  }
  const deadline = Date.now() + Math.min(executionLimits.wait_seconds, Math.max(0, input.wait_seconds || 0)) * 1000;
  while ((!terminal(record) || (active.get(directory) && !active.get(directory).finished)) && Date.now() < deadline) {
    const entry = active.get(directory);
    if (entry) await Promise.race([entry.done, sleep(Math.min(1000, deadline - Date.now()))]);
    else { if (!alive(record.owner_pid)) break; await sleep(Math.min(1000, deadline - Date.now())); }
    record = active.get(directory)?.record || await readRecord(directory);
  }
  const finishing = Boolean(active.get(directory) && !active.get(directory).finished);
  const orphan = !terminal(record) && !active.has(directory) && !alive(record.owner_pid);
  const result = { ...record, ...(finishing && terminal(record) ? { status: 'finishing', success: null, state_persisted: false } : {}),
    ...(orphan ? { status: 'interrupted', execution_state: 'execution_unknown', success: false,
    next_action: 'The owning service exited. Inspect files before deciding whether to submit a new request; this execution is never replayed.' } : {}),
    continue_waiting: (!terminal(record) || finishing) && !orphan, elapsed_seconds: Math.max(0, (Date.parse(record.finished_at || new Date().toISOString()) - Date.parse(record.started_at || record.created_at)) / 1000) };
  const count = Math.min(24000, Math.max(1, input.max_chars || 12000));
  for (const name of ['stdout', 'stderr']) {
    const output = active.get(directory)?.[name] ?? await readFile(path.join(directory, name + '.log'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const offset = Math.max(0, input[name + '_offset'] || 0);
    let end = Math.min(output.length, offset + count);
    if (end > offset && /[\uD800-\uDBFF]/.test(output[end - 1]) && end < output.length) end = end - 1 === offset ? end + 1 : end - 1;
    result[name] = output.slice(offset, end); result[name + '_offset'] = offset;
    result['next_' + name + '_offset'] = end < output.length ? end : null;
    result[name + '_length'] = output.length;
  }
  delete result.fingerprint; delete result.owner_pid;
  return result;
}
export async function cancelLocalExecution(input) {
  const id = identifier(input), directory = keyFor(id), record = active.get(directory)?.record || await readRecord(directory);
  if (!terminal(record) && record.status !== 'finishing') {
    const entry = active.get(directory);
    if (entry) entry.cancelRequested = true;
    await writeFile(path.join(directory, 'cancel'), 'cancel requested\n');
  }
  return { ...await getLocalExecution({ ...input, wait_seconds: input.wait_seconds ?? 5 }),
    cancellation_requested: !terminal(record) && record.status !== 'finishing' };
}
export async function closeLocalExecutions() {
  for (const entry of active.values()) { entry.cancelRequested = true; entry.stopReason ||= 'cancelled'; entry.child?.kill(); }
  await Promise.all([...active.values()].map(entry => entry.done));
}
