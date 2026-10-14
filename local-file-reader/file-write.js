import { pythonExecutable, stateDirectory } from '../shared/runtime-paths.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { JsonLineWorker } from '../shared/json-line-worker.js';

export const writeLimits = { text_bytes: 8 * 1024 * 1024, base64_bytes: 8 * 1024 * 1024, source_bytes: 64 * 1024 * 1024 };
export const writeEncodings = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'windows-1252'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stateRoot = () => process.env.LOCAL_FILE_READER_STATE_DIR || stateDirectory('local-file-reader');
let worker, queue = Promise.resolve();

export class FileWriteError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const refuse = (code, message, details) => { throw new FileWriteError(code, message, details); };
function absolute(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) refuse('INVALID_PATH', 'Use an absolute local file path.');
  const result = path.resolve(input);
  if (process.platform === 'win32') {
    const segments = result.slice(path.parse(result).root.length).split(/[\\/]/);
    if (segments.some(part => /[:]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      refuse('INVALID_PATH', 'Device names, alternate data streams and ambiguous Windows paths are not supported.');
    }
  }
  return result;
}
async function targetPath(input, createParents = false, dryRun = false) {
  const requested = absolute(input);
  let parent = path.dirname(requested), pending = [];
  while (true) {
    try { return path.join(await realpath(parent), ...pending, path.basename(requested)); }
    catch (error) {
      if (!(createParents && error.code === 'ENOENT')) throw error;
      const next = path.dirname(parent); if (next === parent) throw error;
      pending.unshift(path.basename(parent)); parent = next;
    }
  }
}
async function currentFile(file, maximum) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) refuse('UNSAFE_FILE_TARGET', 'Write a regular, non-linked file.');
  if (info.size > maximum) refuse('FILE_TOO_LARGE', `This operation is limited to ${maximum} bytes.`);
  const bytes = await readFile(file), after = await lstat(file);
  if (after.size !== bytes.length || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.ino !== after.ino) {
    refuse('FILE_CHANGED', 'The file changed while being read. Inspect its latest content before editing.');
  }
  return { bytes, info: after, sha256: hash(bytes) };
}
function expectedFile(current, expected) {
  if (!current) refuse('FILE_NOT_FOUND', 'The target file does not exist. Use create mode for a new file.');
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) refuse('HASH_REQUIRED', 'Existing-file changes require expected_sha256 from get_local_path_info(include_hash=true) or an edit preview.');
  if (current.sha256 !== expected.toLowerCase()) refuse('FILE_CHANGED', 'The file differs from the version you inspected; read it again before deciding the change.', { current_sha256: current.sha256 });
}
const byteOrderMarks = { 'utf-8': Buffer.from([0xef, 0xbb, 0xbf]), 'utf-16le': Buffer.from([0xff, 0xfe]), 'utf-16be': Buffer.from([0xfe, 0xff]) };
function binarySignature(bytes) {
  return bytes.subarray(0, 5).toString('ascii') === '%PDF-' || bytes.subarray(0, 2).toString('ascii') === 'MZ' ||
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])) ||
    bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) || /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'));
}
function textFormat(bytes, requested = 'auto') {
  if (binarySignature(bytes)) refuse('BINARY_TEXT_REFUSED', 'This is a container, image or executable. Save complete bytes using data_base64/source_path; text edits do not edit its internal format.');
  let encoding = requested, bom = false, body = bytes;
  for (const [candidate, marker] of Object.entries(byteOrderMarks)) {
    if (bytes.subarray(0, marker.length).equals(marker)) {
      if (encoding !== 'auto' && encoding !== candidate) refuse('ENCODING_MISMATCH', 'Explicit encoding conflicts with the existing byte-order mark.');
      encoding = candidate; bom = true; body = bytes.subarray(marker.length); break;
    }
  }
  if (encoding === 'auto') {
    const sample = body.subarray(0, 4096);
    let even = 0, odd = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? odd++ : even++;
    if (odd > sample.length / 8 && odd > even * 3) encoding = 'utf-16le';
    else if (even > sample.length / 8 && even > odd * 3) encoding = 'utf-16be';
    else { try { new TextDecoder('utf-8', { fatal: true }).decode(body); encoding = 'utf-8'; } catch { encoding = 'gb18030'; } }
  }
  const text = iconv.decode(body, encoding, { stripBOM: false });
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text) || !iconv.encode(text, encoding).equals(body)) {
    refuse('TEXT_DECODE_REFUSED', 'The bytes are binary or cannot round-trip in this encoding. Select the actual encoding, or save complete bytes.');
  }
  return { encoding, bom, text, newline: newlineOf(text) };
}
function newlineOf(text) {
  const endings = new Set(text.match(/\r\n|\r|\n/g) || []);
  return endings.size === 1 ? ({ '\r\n': 'crlf', '\n': 'lf', '\r': 'cr' })[[...endings][0]] : endings.size ? 'mixed' : 'none';
}
function newlines(text, chosen) {
  return ['crlf', 'lf', 'cr'].includes(chosen) ? text.replace(/\r\n|\r|\n/g, { crlf: '\r\n', lf: '\n', cr: '\r' }[chosen]) : text;
}
function encodeText(text, encoding, bom) {
  if (!text.isWellFormed() || text.includes('\0')) refuse('INVALID_TEXT', 'Text must contain well-formed Unicode without NUL; use complete bytes for binary data.');
  const bytes = iconv.encode(text, encoding);
  if (iconv.decode(bytes, encoding, { stripBOM: false }) !== text) refuse('ENCODING_LOSS', `The text cannot be represented without loss in ${encoding}. Choose an appropriate encoding explicitly.`);
  if (bom && !byteOrderMarks[encoding]) refuse('INVALID_BOM', 'BOM is supported only for UTF-8 and UTF-16.');
  return bom ? Buffer.concat([byteOrderMarks[encoding], bytes]) : bytes;
}
async function withWriteLock(action) {
  const run = async () => {
    const directory = stateRoot(); await mkdir(directory, { recursive: true });
    worker ??= new JsonLineWorker(pythonExecutable(),
      [fileURLToPath(new URL('./write-support.py', import.meta.url)), path.join(directory, 'write.lock')],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    await worker.request({ operation: 'acquire', seconds: 5 });
    const child = worker.child;
    let value, failure;
    try { value = await action(worker); } catch (error) { failure = error; }
    if (child === worker.child) {
      try { await worker.request({ operation: 'release' }); }
      catch (error) {
        worker.invalidate(error);
        if (value) value.lock_release_warning = 'The worker stopped after the result was confirmed. Its OS lock is released on exit; the file operation was not replayed.';
      }
    }
    if (failure) throw failure;
    return value;
  };
  const result = queue.then(run); queue = result.catch(() => {}); return result;
}
export async function closeFileWriter() { await queue; await worker?.close(); worker = undefined; }
async function commit(channel, file, current, bytes, dryRun, metadata = {}) {
  const sha256 = hash(bytes);
  const result = { path: file, sha256, previous_sha256: current?.sha256 ?? null, size_bytes: bytes.length,
    changed: !current || sha256 !== current.sha256, dry_run: dryRun, execution_state: 'not_executed', ...metadata };
  if (dryRun || !result.changed) return { ...result, unchanged: !result.changed };
  if (bytes.length > writeLimits.source_bytes) refuse('FILE_TOO_LARGE', 'Output exceeds the 64 MiB byte-save limit.');
  const temporary = path.join(path.dirname(file), `.local-mcp-write-${randomUUID()}.tmp`);
  let backup, createdParent, dispatched = false, committed = false;
  try {
    if (metadata.create_parents) createdParent = await mkdir(path.dirname(file), { recursive: true });
    // Resolve again before staging: a concurrent reparse point must not redirect
    // a write that was validated against a different parent directory.
    if (path.join(await realpath(path.dirname(file)), path.basename(file)).toLowerCase() !== file.toLowerCase()) {
      refuse('FILE_CHANGED', 'The target directory changed during preparation. Inspect it before retrying.');
    }
    const handle = await open(temporary, 'wx', current?.info.mode ?? 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (current) {
      const directory = path.join(stateRoot(), 'backups'); await mkdir(directory, { recursive: true });
      backup = path.join(directory, randomUUID() + path.extname(file));
      const handle = await open(backup, 'wx', 0o600);
      try { await handle.writeFile(current.bytes); await handle.sync(); } finally { await handle.close(); }
      await writeFile(backup+'.metadata.json',JSON.stringify({source_path:file,sha256:current.sha256,created_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
    }
    dispatched = true;
    const reply = await channel.request({ operation: 'publish', temporary, target: file, expected_sha256: current?.sha256 ?? null, sha256 });
    if (!reply.value.ok) { dispatched = false; refuse(reply.value.code, reply.value.error); }
    committed = true;
    return { ...result, execution_state: 'executed', backup_path: backup ?? null, backup_sha256: current?.sha256 ?? null };
  } catch (error) {
    if (dispatched && !committed) throw new FileWriteError('WRITE_RESULT_UNKNOWN', 'The publish reply was lost. Inspect the target SHA256 before deciding what remains; do not replay automatically.',
      { execution_state: 'execution_unknown', path: file, intended_sha256: sha256, backup_path: backup ?? null });
    if (createdParent) {
      error.details = { ...error.details, execution_state: 'not_executed', created_parent: createdParent,
        side_effects: 'Parent directories were created before staging failed; inspect them before any cleanup.' };
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
    if (backup && !dispatched && !committed) {await unlink(backup).catch(() => {});await unlink(backup+'.metadata.json').catch(()=>{});}
  }
}
export async function writeLocalFile({ path: input, content, data_base64, source_path, mode = 'create', expected_sha256,
  encoding = 'auto', bom, newline = 'preserve', create_parents = false, dry_run = false }) {
  if ([content, data_base64, source_path].filter(value => value !== undefined).length !== 1) refuse('PAYLOAD_REQUIRED', 'Provide exactly one of content, data_base64 or source_path.');
  return withWriteLock(async channel => {
    const file = await targetPath(input, create_parents, dry_run);
    const current = await currentFile(file, writeLimits.source_bytes);
    if (mode === 'create') { if (current) refuse('FILE_EXISTS', 'Create mode never overwrites. Inspect the file and use replace with its expected_sha256.'); }
    else expectedFile(current, expected_sha256);
    let bytes, metadata;
    if (content !== undefined) {
      if (current && current.bytes.length > writeLimits.text_bytes) refuse('FILE_TOO_LARGE', 'Text replacement is limited to 8 MiB; complete byte saves support up to 64 MiB.');
      let previous = null;
      if (current) {
        try { previous = textFormat(current.bytes); }
        catch (error) { if (encoding === 'auto' || error.code !== 'TEXT_DECODE_REFUSED') throw error; previous = textFormat(current.bytes, encoding); }
      }
      const actualEncoding = encoding === 'auto' ? previous?.encoding || 'utf-8' : encoding;
      const actualBom = bom ?? (actualEncoding === previous?.encoding && previous.bom) ?? false;
      const actualNewline = newline === 'preserve' ? previous?.newline || 'none' : newline;
      const text = newlines(content, actualNewline);
      bytes = encodeText(text, actualEncoding, actualBom);
      if (bytes.length > writeLimits.text_bytes) refuse('FILE_TOO_LARGE', 'Text output exceeds 8 MiB.');
      metadata = { payload: 'text', encoding: actualEncoding, bom: actualBom, newline: newlineOf(text) };
    } else if (data_base64 !== undefined) {
      if (encoding !== 'auto' || bom !== undefined || newline !== 'preserve') refuse('BINARY_OPTIONS', 'Encoding/BOM/newline options apply only to content text.');
      if (data_base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data_base64)) refuse('INVALID_BASE64', 'Supply canonical base64 without whitespace or a data URL prefix.');
      bytes = Buffer.from(data_base64, 'base64');
      if (bytes.length > writeLimits.base64_bytes || bytes.toString('base64') !== data_base64) refuse('INVALID_BASE64', 'Base64 is invalid or decoded data exceeds 8 MiB.');
      metadata = { payload: 'complete_bytes', encoding: 'binary' };
    } else {
      if (encoding !== 'auto' || bom !== undefined || newline !== 'preserve') refuse('BINARY_OPTIONS', 'Encoding/BOM/newline options apply only to content text.');
      const source = await currentFile(await targetPath(source_path), writeLimits.source_bytes);
      if (!source) refuse('SOURCE_NOT_FOUND', 'The source file does not exist.');
      bytes = source.bytes; metadata = { payload: 'source_bytes', encoding: 'binary', source_path: absolute(source_path), source_sha256: source.sha256 };
    }
    return commit(channel, file, current, bytes, dry_run, { ...metadata, create_parents });
  });
}
export async function editLocalFile({ path: input, edits, expected_sha256, encoding = 'auto', dry_run = false }) {
  if (!Array.isArray(edits) || !edits.length || edits.reduce((sum, edit) => sum + edit.old_text.length + edit.new_text.length, 0) > writeLimits.text_bytes) refuse('EDIT_SIZE_LIMIT', 'Provide nonempty edits with at most 8 MiB total old/new text.');
  return withWriteLock(async channel => {
    const file = await targetPath(input), current = await currentFile(file, writeLimits.text_bytes);
    if (!current) refuse('FILE_NOT_FOUND', 'The file to edit does not exist.');
    if (!dry_run || expected_sha256) expectedFile(current, expected_sha256);
    const format = textFormat(current.bytes, encoding), replacements = [], preview = [];
    for (const edit of edits) {
      const oldText = newlines(edit.old_text, format.newline), newText = newlines(edit.new_text, format.newline);
      if (!oldText.length) refuse('EMPTY_MATCH', 'old_text must be nonempty. Use write_local_file for a complete replacement.');
      const positions = []; let offset = 0, index;
      while ((index = format.text.indexOf(oldText, offset)) >= 0) {
        positions.push(index); offset = index + oldText.length;
        if (positions.length > 10000) refuse('TOO_MANY_MATCHES', 'Use a more specific old_text.');
      }
      if (positions.length !== (edit.expected_count ?? 1)) refuse('MATCH_COUNT', 'old_text did not match the requested number of occurrences; no edits were applied.', { expected_count: edit.expected_count ?? 1, match_count: positions.length });
      for (const start of positions) replacements.push({ start, end: start + oldText.length, newText });
      if (replacements.length > 10000) refuse('TOO_MANY_MATCHES', 'At most 10000 total replacements are supported.');
      preview.push({ match_count: positions.length, old_text: oldText.slice(0, 200), new_text: newText.slice(0, 200),
        snippets_truncated: oldText.length > 200 || newText.length > 200 });
    }
    replacements.sort((a, b) => a.start - b.start);
    for (let i = 1; i < replacements.length; i++) if (replacements[i].start < replacements[i - 1].end) refuse('OVERLAPPING_EDITS', 'Edits overlap in the original file. Split or revise the requested replacements.');
    let cursor = 0; const parts = [];
    for (const replacement of replacements) { parts.push(format.text.slice(cursor, replacement.start), replacement.newText); cursor = replacement.end; }
    parts.push(format.text.slice(cursor));
    const output = parts.join(''), bytes = encodeText(output, format.encoding, format.bom);
    if (bytes.length > writeLimits.text_bytes) refuse('FILE_TOO_LARGE', 'Edited text exceeds 8 MiB.');
    return commit(channel, file, current, bytes, dry_run, { payload: 'text_edit', encoding: format.encoding, bom: format.bom,
      newline: newlineOf(output), replacements: replacements.length, edits_preview: preview.slice(0, 20), preview_truncated: preview.length > 20 });
  });
}
