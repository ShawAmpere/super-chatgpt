import { execFile } from "node:child_process";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { streamTextLines } from './stream-text.js';
import { scanFilters } from './scan-filters.js';
import { documentFormats, searchDocument } from "./local-documents.js";

const execFileAsync = promisify(execFile);
const imageTypes = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".webp", "image/webp"], [".gif", "image/gif"],
  [".bmp", "image/bmp"], [".tif", "image/tiff"], [".tiff", "image/tiff"], [".ico", "image/x-icon"], [".avif", "image/avif"],
]);
const maxSearchFileBytes = 8 * 1024 * 1024;
const scans = new Map();
const textCache = new Map();
let textCacheChars = 0;

async function textLines(file, info, encoding) {
  const precise = await stat(file, { bigint: true });
  const bytes = await readFile(file);
  // NTFS can reuse the same timestamp for rapid same-size replacements. Cache
  // decoding/splitting, never assume metadata alone identifies these bytes.
  const key = `${file}:${precise.ino}:${encoding}:${createHash('sha256').update(bytes).digest('hex')}`;
  const after = await stat(file, { bigint: true });
  if (precise.ino !== after.ino || precise.size !== after.size || precise.mtimeNs !== after.mtimeNs || precise.ctimeNs !== after.ctimeNs) throw new Error('File changed during text reading; restart with its current version.');
  if (textCache.has(key)) { const value = textCache.get(key); textCache.delete(key); textCache.set(key, value); return value; }
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const value = { lines: text.split(/\r\n|\n|\r/), chars: text.length };
  if (value.chars <= 4 * 1024 * 1024) {
    while ((textCacheChars + value.chars > 16 * 1024 * 1024 || textCache.size >= 20) && textCache.size) {
      const oldest = textCache.keys().next().value; textCacheChars -= textCache.get(oldest).chars; textCache.delete(oldest);
    }
    textCache.set(key, value); textCacheChars += value.chars;
  }
  return value;
}

export async function existingPath(input, expected = null) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error("path must be an absolute local path.");
  }
  const resolved = await realpath(input);
  const info = await stat(resolved);
  if (expected === "file" && !info.isFile()) throw new Error("path must name a regular file.");
  if (expected === "directory" && !info.isDirectory()) throw new Error("path must name a directory.");
  return { path: resolved, info };
}

export async function listLocalLocations() {
  const locations = [{ path: os.homedir(), label: "User home", kind: "home" }];
  if (process.platform === "win32") {
    try {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await execFileAsync(powershell, [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root | ConvertTo-Json -Compress",
      ], { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 16384 });
      const roots = JSON.parse(stdout.trim());
      for (const root of Array.isArray(roots) ? roots : [roots]) {
        if (typeof root === "string" && path.isAbsolute(root)) locations.push({ path: root, label: root, kind: "drive" });
      }
    } catch {
      const root = (process.env.SystemDrive || process.env.HOMEDRIVE || "C:") + "\\";
      locations.push({ path: root, label: root, kind: "drive" });
    }
  } else {
    locations.push({ path: "/", label: "/", kind: "root" });
  }
  return { locations: locations.filter((item, index) =>
    locations.findIndex((other) => other.path.toLowerCase() === item.path.toLowerCase()) === index) };
}

export async function getLocalPathInfo({ path: input, include_hash = false }) {
  const { path: resolved, info } = await existingPath(input);
  const extension = info.isFile() ? path.extname(resolved).toLowerCase() : null;
  let sha256;
  if (include_hash && info.isFile()) {
    if (info.size > 64 * 1024 * 1024) throw new Error('SHA256 path inspection is limited to 64 MiB files.');
    const bytes = await readFile(resolved), after = await stat(resolved);
    if (info.size !== bytes.length || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.ino !== after.ino) throw new Error('File changed during SHA256 inspection; read its current version again.');
    sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  return {
    path: resolved, kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    size_bytes: info.isFile() ? info.size : null, modified_at: info.mtime.toISOString(),
    extension, supported_document: documentFormats.has(extension), supported_image: imageTypes.has(extension),
    ...(sha256 ? { sha256 } : {}),
  };
}

export async function listLocalDirectory({ path: input, offset = 0, limit = 100 }) {
  const { path: directory } = await existingPath(input || os.homedir(), "directory");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const selected = entries.slice(offset, offset + limit);
  return {
    path: directory, total_entries: entries.length, offset,
    next_offset: offset + selected.length < entries.length ? offset + selected.length : null,
    entries: selected.map((entry) => ({
      name: entry.name, path: path.join(directory, entry.name),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other",
    })),
  };
}

async function walkDirectory(root, { max_depth, max_entries, timeout_ms, cursor, identity, filters }, visit) {
  for (const [id, scan] of scans) if (Date.now() - scan.at > 15 * 60 * 1000) scans.delete(id);
  const id = cursor || randomUUID();
  let scan = cursor ? scans.get(cursor) : { root, identity, max_depth, queue: [{ directory: root, depth: 0 }], current: null,
    skipped: 0, skippedFiles: 0, depthSkipped: 0, excludedDirs: 0, excludedFiles: 0, total: 0, at: Date.now(), fileResume: null };
  if (!scan || scan.root !== root || scan.identity !== identity || scan.max_depth !== max_depth) throw new Error("Scan cursor expired or parameters changed; restart the search.");
  scans.delete(id);
  if (scan.current && (await stat(scan.current.directory)).mtimeMs !== scan.current.mtime) throw new Error("Directory changed during a paged search; restart to avoid missing entries.");
  const deadline = Date.now() + timeout_ms;
  let examined = 0;
  const finish = (reason, more) => {
    if (more) { scan.at = Date.now(); if (scans.size >= 16) scans.delete(scans.keys().next().value); scans.set(id, scan); }
    return { examined_entries: examined, total_examined_entries: scan.total, skipped_directories: scan.skipped,
      depth_limited_directories: scan.depthSkipped, truncated: Boolean(reason || scan.depthSkipped),
      skipped_files: scan.skippedFiles, excluded_directories: scan.excludedDirs, excluded_files: scan.excludedFiles,
      scan_scope: filters.scope, scope_complete: !more && !scan.skipped && !scan.depthSkipped && !scan.skippedFiles,
      coverage_complete: !more && !scan.skipped && !scan.depthSkipped && !scan.skippedFiles && !scan.excludedDirs && !scan.excludedFiles,
      stop_reason: reason || (scan.depthSkipped ? "depth_limit" : scan.skipped ? "unreadable_directories" : null), next_cursor: more ? id : null };
  };
  while (scan.current || scan.queue.length) {
    if (Date.now() >= deadline || examined >= max_entries) return finish(Date.now() >= deadline ? "time_limit" : "entry_limit", true);
    if (!scan.current) {
      const current = scan.queue.shift();
      try {
        current.entries = await readdir(current.directory, { withFileTypes: true });
        current.mtime = (await stat(current.directory)).mtimeMs;
      } catch { scan.skipped++; continue; }
      current.entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      current.index = 0; scan.current = current;
    }
    const current = scan.current;
    if (current.index >= current.entries.length) { scan.current = null; continue; }
    const entry = current.entries[current.index], entryPath = path.join(current.directory, entry.name);
    examined++; scan.total++;
    if (!scan.fileResume && (filters.excluded(root, entryPath, entry.isDirectory()) || !entry.isDirectory() && !filters.includes(entryPath))) {
      if (entry.isDirectory()) scan.excludedDirs++; else scan.excludedFiles++;
      current.index++; continue;
    }
    if (!scan.fileResume && entry.isDirectory()) {
      if (current.depth < max_depth) scan.queue.push({ directory: entryPath, depth: current.depth + 1 });
      else scan.depthSkipped++;
    }
    const result = await visit(entry, entryPath, scan.fileResume);
    if (result?.skippedFile) scan.skippedFiles++;
    scan.fileResume = result?.resume || null;
    if (!scan.fileResume) current.index++;
    if (result === true || result?.stop) return finish(result?.reason || "result_limit", true);
  }
  return finish(null, false);
}

export async function findLocalFiles({
  path: input, name_contains = "", extensions = [], max_depth = 12,
  max_results = 100, max_entries = 10000, timeout_ms = 10000, cursor,
  exclude_dirs = [], exclude_patterns = [], include_extensions = [], use_default_excludes = true,
}) {
  const { path: root } = await existingPath(input, "directory");
  const needle = name_contains.toLocaleLowerCase();
  const filters = scanFilters({exclude_dirs, exclude_patterns, include_extensions, extensions, use_default_excludes});
  const matches = [];
  const identity = JSON.stringify(["find", name_contains, filters.identity]);
  const progress = await walkDirectory(root, { max_depth, max_entries, timeout_ms, cursor, identity, filters }, (entry, entryPath) => {
    if (entry.isDirectory() || !entry.name.toLocaleLowerCase().includes(needle)) return false;
    matches.push({ path: entryPath, name: entry.name,
      kind: entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other" });
    return matches.length >= max_results;
  });
  return { root, matches, ...progress };
}

async function detectEncoding(file, requested = "auto") {
  if (requested !== "auto") return requested;
  const handle = await open(file, "r");
  try {
    const sample = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, bytesRead);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
    let zeros = 0, evenZeros = 0, controls = 0;
    for (let index = 0; index < bytes.length; index++) {
      const value = bytes[index];
      if (value === 0) { zeros++; if (index % 2 === 0) evenZeros++; }
      if (value < 32 && ![9, 10, 12, 13].includes(value)) controls++;
    }
    if (zeros > bytes.length / 8) {
      if (zeros - evenZeros > bytes.length / 4) return "utf-16le";
      if (evenZeros > bytes.length / 4) return "utf-16be";
      throw new Error("File appears binary. Use a document or image reader if appropriate.");
    }
    if (controls > bytes.length / 16) throw new Error("File appears binary; text decoding was not attempted.");
    try {
      const utf8 = new TextDecoder("utf-8", { fatal: true });
      for (let trim = 0; trim <= Math.min(3, bytes.length); trim++) {
        try { utf8.decode(bytes.subarray(0, bytes.length - trim)); return "utf-8"; }
        catch { /* A sample can end inside one UTF-8 code point. */ }
      }
      throw new Error("Invalid UTF-8 sample.");
    }
    catch { return "gb18030"; }
  } finally { await handle.close(); }
}

function decodePrefix(bytes, encoding) {
  for (let count = bytes.length; count >= Math.max(0, bytes.length - 4); count--) {
    if (encoding.startsWith("utf-16") && count % 2) continue;
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(0, count)), bytes: count };
    } catch { /* A trailing multibyte character may be incomplete. */ }
  }
  throw new Error("Could not decode this chunk as " + encoding + "; choose the file's actual encoding.");
}

export async function readLocalText({
  path: input, mode = "bytes", offset = 0, max_bytes = 16384,
  start_line = 1, max_lines = 100, encoding = "auto",
}) {
  const { path: file, info } = await existingPath(input, "file");
  const extension = path.extname(file).toLowerCase();
  if (documentFormats.has(extension)) throw new Error("Use read_local_document for this format.");
  if (imageTypes.has(extension)) throw new Error("Use view_local_image for this format.");
  const actualEncoding = await detectEncoding(file, encoding);
  if (mode === "lines") {
    if (info.size > 32 * 1024 * 1024) throw new Error("Line mode is limited to 32 MiB; use byte-offset mode.");
    const allLines = info.size <= 4 * 1024 * 1024 ? (await textLines(file, info, actualEncoding)).lines : streamTextLines(file, actualEncoding);
    const lines = [];
    let totalChars = 0;
    let nextLine = null;
    let index = -1;
    for await (const row of allLines) {
      const line = typeof row === 'string' ? row : row.text;
      index++;
      if (index < start_line - 1) continue;
      if (lines.length >= max_lines) { nextLine = index + 1; break; }
      const shown = line.slice(0, 2000);
      if (totalChars + shown.length > 30000) { nextLine = index + 1; break; }
      lines.push({ number: index + 1, text: shown, truncated: line.length > shown.length });
      totalChars += shown.length;
    }
    return { path: file, mode, encoding: actualEncoding, lines,
      next_line: nextLine, eof: nextLine === null,
      file_size_bytes: info.size, modified_at: info.mtime.toISOString() };
  }
  if (offset > info.size) throw new Error("offset is beyond the end of the file.");
  if (actualEncoding.startsWith("utf-16") && offset % 2) throw new Error("UTF-16 byte offsets must be even.");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(max_bytes, info.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const decoded = decodePrefix(buffer.subarray(0, bytesRead), actualEncoding);
    if (bytesRead && (!decoded.bytes || (offset + bytesRead >= info.size && decoded.bytes < bytesRead))) {
      throw new Error("File ends in an invalid or incomplete encoded character; choose the correct encoding.");
    }
    const next = offset + decoded.bytes;
    return { path: file, mode, encoding: actualEncoding, offset, text: decoded.text,
      next_offset: next < info.size ? next : null, eof: next >= info.size,
      file_size_bytes: info.size, modified_at: info.mtime.toISOString() };
  } finally { await handle.close(); }
}

export async function viewLocalImage({ path: input }) {
  const { path: file, info } = await existingPath(input, "file");
  const mimeType = imageTypes.get(path.extname(file).toLowerCase());
  if (!mimeType) throw new Error("Supported images are PNG, JPEG, WEBP, and GIF.");
  if (info.size > 10 * 1024 * 1024) throw new Error("Image exceeds the 10 MiB result limit.");
  return { path: file, mimeType, size_bytes: info.size, data: (await readFile(file)).toString("base64") };
}

export async function searchLocalText({
  path: input, query, case_sensitive = false, include_documents = false,
  max_depth = 8, max_matches = 100, max_entries = 5000, timeout_ms = 15000, cursor,
  exclude_dirs = [], exclude_patterns = [], include_extensions = [], use_default_excludes = true,
}) {
  const { path: root } = await existingPath(input, "directory");
  const needle = case_sensitive ? query : query.toLocaleLowerCase();
  const matches = [];
  const deadline = Date.now() + timeout_ms;
  const filters = scanFilters({exclude_dirs, exclude_patterns, include_extensions, use_default_excludes});
  const identity = JSON.stringify(["search", query, case_sensitive, include_documents, filters.identity]);
  const progress = await walkDirectory(root, { max_depth, max_entries, timeout_ms, cursor, identity, filters }, async (entry, file, resume) => {
    if (!entry.isFile()) return false;
    const extension = path.extname(file).toLowerCase();
    if (imageTypes.has(extension) || (documentFormats.has(extension) && !include_documents)) return false;
    try {
      const info = await stat(file, { bigint: true });
      if (info.size > (documentFormats.has(extension) ? 40 * 1024 * 1024 : maxSearchFileBytes)) return { skippedFile: true };
      const signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (resume && resume.signature !== signature) throw new Error("Search file changed during paging.");
      if (documentFormats.has(extension)) {
        const result = await searchDocument(file, { query, case_sensitive, max_matches: max_matches - matches.length, cursor: resume?.document_cursor });
        matches.push(...result.matches.map((item) => ({ path: file, ...item })));
        return { stop: matches.length >= max_matches, resume: result.next_cursor ? { signature, document_cursor: result.next_cursor } : null };
      } else {
        const encoding = resume?.encoding || await detectEncoding(file);
        const streaming = info.size > 1024 * 1024;
        const lines = streaming ? streamTextLines(file, encoding, resume?.byte_offset || 0) : (await textLines(file, info, encoding)).lines;
        let index = resume?.byte_offset != null ? (resume.line || 0) - 1 : -1;
        for await (const entry of lines) {
          const line = streaming ? entry.text : entry;
          index++;
          if (index < (resume?.line || 0)) continue;
          if (Date.now() > deadline) return {stop:true, reason:'time_limit', resume:{signature,line:index,
            ...(streaming ? {byte_offset:entry.offset,encoding} : {})}};
          const haystack = case_sensitive ? line : line.toLocaleLowerCase();
          const column = haystack.indexOf(needle);
          if (column < 0) continue;
          matches.push({
            path: file,
            line: index + 1, column: column + 1,
            snippet: line.slice(Math.max(0, column - 80), column + query.length + 120),
          });
          if (matches.length >= max_matches) return { stop: true, resume: { signature, line: index + 1,
            ...(streaming ? {byte_offset:entry.nextOffset,encoding} : {}) } };
        }
      }
    } catch (error) {
      if (/changed during paging/.test(error.message)) throw error;
      return { skippedFile: true };
    }
    return matches.length >= max_matches;
  });
  return { root, query, include_documents, matches, ...progress };
}
