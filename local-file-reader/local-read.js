import { pythonExecutable } from '../shared/runtime-paths.js';
import { execFile } from "node:child_process";
import { access, open, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { existingPath, readLocalText, viewLocalImage } from "./local-files.js";
import { documentFormats, readLocalDocument } from "./local-documents.js";
import { writeEncodings, writeLimits } from './file-write.js';
import { editorCapabilities } from './editor-runtime.js';
import { executionLimits } from './local-execution.js';

const execFileAsync = promisify(execFile);
const python = pythonExecutable();
const nativeImages = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const convertedImages = new Set([".bmp", ".tif", ".tiff", ".ico", ".avif"]);

export async function readerCapabilities() {
  const converter = process.env.LOCAL_FILE_READER_LIBREOFFICE || "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
  return { text: "Any text/code extension, including CSV, TSV, JSON, HTML, XML, YAML, logs and extensionless text.",
    documents: [...documentFormats], images: [...nativeImages, ...convertedImages],
    libreoffice_available: await access(converter).then(() => true, () => false),
    document_visuals: "Render one PDF page; other supported documents can be converted to PDF through LibreOffice.",
    other_binary: "Metadata and a bounded hex preview only; arbitrary binary files, audio/video, encrypted files and proprietary formats are not promised semantic extraction.",
    document_editing: { ...await editorCapabilities(), tool: 'edit_local_document',
      methods: 'Python format libraries with staged INPUT_PATH/OUTPUT_PATH; optional LibreOffice conversion.',
      limitations: 'PDF is fixed-layout: page/area edits and annotations, not automatic reflow or scanned-text OCR. Conversion fidelity and visual layout must be checked.' },
    local_execution: { tool: 'run_local_command', languages: ['powershell', 'python', 'javascript', 'executable'],
      query: 'get_local_execution', cancel: 'cancel_local_execution', limits: executionLimits,
      privileges: 'Current Windows user; process-tree isolation is not a security sandbox.', request_id_required: true },
    writing: { text: 'Any decodable text/code/config extension, including unknown extensions and extensionless files.',
      encodings: writeEncodings, complete_bytes: 'Save base64 data or copy source_path unchanged for any extension; not semantic format editing.',
      overwrite: 'Requires expected_sha256; originals are backed up. Create mode never overwrites.',
      limits: writeLimits },
    limits: { batch_chars: 24000, max_batch_files: 20, document_input_mib: 40, document_timeout_seconds: 30,
      concurrent_document_readers: 2, cache_idle_minutes: 10, zip_expanded_mib: 128 } };
}

export async function renderLocalImage({ path: input, page }) {
  const { path: file, info } = await existingPath(input, "file");
  const extension = path.extname(file).toLowerCase();
  if (page == null && nativeImages.has(extension)) return viewLocalImage({ path: file });
  if (page == null && !convertedImages.has(extension)) throw new Error("Unsupported image conversion; use a document page or supported image format.");
  if (page != null && !documentFormats.has(extension)) throw new Error("Page rendering requires a supported document.");
  if (page != null && [".zip", ".jar", ".whl", ".epub"].includes(extension)) throw new Error("This reader provides entry/chapter text; page rendering is unavailable for this format.");
  if (info.size > (page == null ? 10 : 40) * 1024 * 1024) throw new Error("File exceeds the visual reader input limit.");
  const temp = await mkdtemp(path.join(os.tmpdir(), "local-file-reader-image-"));
  const environment = { ...process.env, DOCUMENT_WORK_DIR: temp, PROCESS_JOB_MEMORY_LIMIT: String(512 * 1024 * 1024) };
  delete environment.CONTROL_PLANE_API_KEY;
  try {
    const args = [fileURLToPath(new URL("./process-support.py", import.meta.url)), "supervise", python,
      fileURLToPath(new URL("./image-reader.py", import.meta.url)), file, ...(page == null ? [] : [String(page)])];
    const { stdout } = await execFileAsync(python, args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 15 * 1024 * 1024, env: environment });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return { path: file, size_bytes: info.size, ...result, note: "Visual preview is bounded to 4096 pixels per side; source is unchanged." };
  } finally { await rm(temp, { recursive: true, force: true }).catch(() => {}); }
}

export async function readLocalFile({ path: input, section, offset = 0, max_chars = 12000 }) {
  const { path: file, info } = await existingPath(input, "file");
  const extension = path.extname(file).toLowerCase();
  if (documentFormats.has(extension)) {
    if (section) return readLocalDocument({ path: file, section, offset, max_chars });
    const index = await readLocalDocument({ path: file, index_limit: 10 });
    if (index.total_sections === 1) return readLocalDocument({ path: file, section: index.sections[0].id, offset, max_chars });
    return { ...index, note: "Multiple sections: select a section id. Use read_local_document with next_offset to continue the index." };
  }
  if (nativeImages.has(extension) || convertedImages.has(extension)) return { path: file, kind: "image", reader: "view_local_image",
    note: "Call view_local_image for pixels. Batch reads do not embed images in a text budget." };
  try { return await readLocalText({ path: file, offset, max_bytes: Math.min(65536, max_chars) }); }
  catch (error) {
    if (!/binary|decode|encoded character/.test(error.message)) throw error;
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(Math.min(256, info.size)); const read = await handle.read(bytes, 0, bytes.length, 0);
      return { path: file, kind: "binary", size_bytes: info.size, preview_hex: bytes.subarray(0, read.bytesRead).toString("hex"),
        content_readable: false, reason: error.message, note: "This is a binary preview, not a semantic reading of the file." };
    } finally { await handle.close(); }
  }
}

export async function readLocalFiles({ files, max_total_chars = 24000 }) {
  const results = []; let remaining = max_total_chars, index = 0;
  for (; index < files.length; index++) {
    if (remaining < 1000) break;
    const file = files[index], quota = Math.min(file.max_chars || 12000, remaining - 500);
    try {
      const result = await readLocalFile({ ...file, max_chars: quota });
      const actual = JSON.stringify(result).length;
      if (actual > remaining) { results.push({ path: file.path, deferred: true, reason: "Result metadata exceeds the remaining batch budget; read separately." }); break; }
      results.push(result); remaining -= actual;
    } catch (error) { const result = { path: file.path, error: error.message }; results.push(result); remaining -= JSON.stringify(result).length; }
  }
  return { files: results, max_total_chars, returned_chars: max_total_chars - remaining,
    next_file_index: index < files.length ? index : null,
    note: "Follow each file's next_offset and deferred file index for complete reading. This bounds one response, not the entire Chat context." };
}
