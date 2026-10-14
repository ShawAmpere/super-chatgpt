import { pythonExecutable } from '../shared/runtime-paths.js';
import { spawn, execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pool = new Map();
const python = pythonExecutable();
const support = fileURLToPath(new URL("./process-support.py", import.meta.url));
const worker = fileURLToPath(new URL("./document-worker.js", import.meta.url));
const TTL = 10 * 60 * 1000;
const limit = 2;
let poolQueue = Promise.resolve();

async function dispose(entry) {
  if (entry.dead) return;
  entry.dead = true;
  pool.delete(entry.file);
  clearTimeout(entry.idle);
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    await execFileAsync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(entry.child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }).catch(() => entry.child.kill());
  }
  await entry.closed;
  for (const pending of entry.pending.values()) pending.reject(new Error("Document parser stopped or exceeded its resource/time limit."));
  entry.pending.clear();
  await rm(entry.temp, { recursive: true, force: true }).catch(() => {});
}

async function acquire(file, signature) {
  const previous = poolQueue;
  let release;
  poolQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    let entry = pool.get(file);
    if (entry && (entry.dead || entry.signature !== signature)) { await dispose(entry); entry = null; }
    if (!entry) {
      if (pool.size >= limit) {
        const oldest = [...pool.values()].filter((item) => !item.busy).sort((a, b) => a.used - b.used)[0];
        if (!oldest) throw new Error("Both document readers are busy; retry after the active reads finish.");
        await dispose(oldest);
      }
      const temp = await mkdtemp(path.join(os.tmpdir(), "local-file-reader-doc-"));
      const environment = { ...process.env, DOCUMENT_WORK_DIR: temp, PROCESS_JOB_MEMORY_LIMIT: String(512 * 1024 * 1024) };
      delete environment.CONTROL_PLANE_API_KEY;
      const child = spawn(python, [support, "supervise", process.execPath, "--max-old-space-size=256", worker, file],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
      entry = { file, signature, temp, child, pending: new Map(), queue: Promise.resolve(), busy: 0, used: Date.now(), dead: false, buffer: "" };
      entry.closed = new Promise((resolve) => child.once("close", resolve));
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        for (const pending of entry.pending.values()) pending.reject(error);
      });
      child.stderr.on("data", (chunk) => { entry.diagnostic = (String(entry.diagnostic || "") + chunk).slice(-2000); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        entry.buffer += chunk;
        if (entry.buffer.length > 4 * 1024 * 1024) { void dispose(entry); return; }
        let newline;
        while ((newline = entry.buffer.indexOf("\n")) >= 0) {
          const line = entry.buffer.slice(0, newline); entry.buffer = entry.buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line); const pending = entry.pending.get(response.id);
            if (!pending) continue;
            entry.pending.delete(response.id);
            if (response.error) pending.reject(new Error(response.error)); else pending.resolve(response.value);
          } catch { void dispose(entry); }
        }
      });
      child.once("close", () => {
        for (const pending of entry.pending.values()) pending.reject(new Error(entry.diagnostic || "Document worker exited."));
        entry.pending.clear();
        if (!entry.dead) void dispose(entry);
      });
      pool.set(file, entry);
    }
    entry.busy++; entry.used = Date.now(); clearTimeout(entry.idle);
    return entry;
  } finally { release(); }
}

export async function documentRequest(input, operation, options = {}) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("path must be an absolute local path.");
  const file = await realpath(input); const info = await stat(file);
  if (!info.isFile()) throw new Error("path must name a regular file.");
  if (info.size > 40 * 1024 * 1024) throw new Error("Document exceeds the 40 MiB input limit.");
  const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const entry = await acquire(file, signature);
  const work = async () => {
    if (entry.dead) throw new Error("Document reader has stopped; retry.");
    const id = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        entry.pending.set(id, { resolve, reject });
        timer = setTimeout(() => { reject(new Error("Document operation exceeded 30 seconds; parser and converter were stopped.")); void dispose(entry); }, 30000);
        entry.child.stdin.write(JSON.stringify({ id, operation, options }) + "\n", (error) => { if (error) reject(error); });
      });
    } finally { clearTimeout(timer); entry.pending.delete(id); }
  };
  const promise = entry.queue.then(work);
  entry.queue = promise.catch(() => {});
  try {
    const value = await promise;
    const after = await stat(file);
    if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== signature) {
      await dispose(entry); throw new Error("File changed during reading; restart from its index.");
    }
    return { path: file, size_bytes: info.size, modified_at: info.mtime.toISOString(), ...value };
  } finally {
    entry.busy--;
    if (!entry.dead && !entry.busy) {
      entry.idle = setTimeout(() => { void dispose(entry); }, TTL); entry.idle.unref?.();
    }
  }
}

export async function closeDocumentReaders() { await Promise.all([...pool.values()].map(dispose)); }
