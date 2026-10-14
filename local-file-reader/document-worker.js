import { createInterface } from "node:readline";
import { readFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocumentSections, getDocumentSectionText, documentArchive } from "./document-extract.js";

const execFileAsync = promisify(execFile), file = process.argv[2];
// Parser diagnostics must never corrupt the JSON response stream.
console.log = console.warn = (...args) => process.stderr.write(args.map(String).join(" ") + "\n");
const originalFormat = path.extname(file).toLowerCase();
const modern = new Map([[".docm", ".docx"], [".dotx", ".docx"], [".dotm", ".docx"],
  [".xlsm", ".xlsx"], [".xltx", ".xlsx"], [".xltm", ".xlsx"], [".pptm", ".pptx"], [".ppsx", ".pptx"], [".potx", ".pptx"]]);
const conversions = new Map([
  ...[".doc", ".dot", ".rtf", ".odt", ".ott"].map((extension) => [extension, "docx"]),
  ...[".xls", ".xlsb", ".xlt", ".ods", ".ots"].map((extension) => [extension, "xlsx"]),
  ...[".ppt", ".pps", ".pot", ".odp", ".otp"].map((extension) => [extension, "pptx"]),
]);
let loaded, sections;
const sectionCache = new Map();
let cachedChars = 0;

async function loadDocument() {
  let format = modern.get(originalFormat) || originalFormat, buffer;
  const conversion = conversions.get(format);
  if (conversion) {
    const base = process.env.DOCUMENT_WORK_DIR;
    if (!base) throw new Error("Missing isolated conversion workspace.");
    const profile = path.join(base, "profile"), output = path.join(base, "output");
    // A failed conversion can leave an apparently valid old output behind.
    // This directory is owned exclusively by this isolated document worker.
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    const soffice = process.env.LOCAL_FILE_READER_LIBREOFFICE || "C:\\Program Files\\LibreOffice\\program\\soffice.exe";
    try {
      await execFileAsync(soffice, ["-env:UserInstallation=" + pathToFileURL(profile).href,
        "--headless", "--nologo", "--nodefault", "--nolockcheck", "--convert-to", conversion, "--outdir", output, file],
        { windowsHide: true, timeout: 25000, maxBuffer: 65536 });
      const names = (await readdir(output)).filter((name) => path.extname(name).toLowerCase() === "." + conversion);
      if (names.length !== 1) throw new Error("Converter did not produce exactly one supported document.");
      const converted = path.join(output, names[0]);
      if ((await stat(converted)).size > 40 * 1024 * 1024) throw new Error("Converted document exceeds the input limit.");
      buffer = await readFile(converted); format = "." + conversion;
    } catch (error) { throw new Error("This format requires LibreOffice conversion: " + error.message); }
  } else buffer = await readFile(file);
  if ([".docx", ".xlsx", ".pptx", ".epub", ".zip", ".jar", ".whl"].includes(format)) {
    const archive = await documentArchive(buffer), entries = Object.values(archive.files);
    const expanded = entries.reduce((sum, entry) => sum + (entry._data?.uncompressedSize || 0), 0);
    if (entries.length > 20000 || expanded > 128 * 1024 * 1024 || entries.some((entry) => (entry._data?.uncompressedSize || 0) > 32 * 1024 * 1024)) {
      throw new Error("Document exceeds the ZIP expansion or entry limits.");
    }
  }
  return { format, buffer };
}

async function readyDocument() {
  try { return await (loaded ||= loadDocument()); }
  catch (error) { loaded = null; sections = null; throw error; }
}

async function getText(id) {
  if (sectionCache.has(id)) return sectionCache.get(id);
  const document = await readyDocument();
  const text = await getDocumentSectionText(document.format, document.buffer, id);
  if (text.length > 16 * 1024 * 1024) throw new Error("Extracted section exceeds the 16 MiB character limit.");
  while (cachedChars + text.length > 16 * 1024 * 1024 && sectionCache.size) {
    const key = sectionCache.keys().next().value; cachedChars -= sectionCache.get(key).length; sectionCache.delete(key);
  }
  sectionCache.set(id, text); cachedChars += text.length;
  return text;
}

async function action(operation, options) {
  const document = await readyDocument();
  sections ||= await getDocumentSections(document.format, document.buffer);
  const shared = { format: originalFormat, converted_format: document.format !== originalFormat ? document.format : null };
  if (operation === "index") {
    const offset = options.offset || 0, size = options.index_limit || 100;
    return { ...shared, mode: "index", total_sections: sections.length, sections: sections.slice(offset, offset + size),
      next_offset: offset + size < sections.length ? offset + size : null,
      note: "Text extraction can omit images, charts, scanned pages and layout. Use sections for complete text coverage." };
  }
  if (operation === "section") {
    if (!sections.some((section) => section.id === options.section)) throw new Error("Unknown document section.");
    const text = await getText(options.section), offset = options.offset || 0, max = options.max_chars || 12000;
    if (offset > text.length) throw new Error("offset is beyond the end of the section.");
    const next = Math.min(text.length, offset + max);
    return { ...shared, mode: "section", section: options.section, offset, text: text.slice(offset, next),
      next_offset: next < text.length ? next : null, eof: next >= text.length, extracted_chars: text.length,
      note: text.length ? null : "No extractable text; this section may contain images only." };
  }
  if (operation === "search") {
    const matches = [], needle = options.case_sensitive ? options.query : options.query.toLocaleLowerCase();
    let remaining = options.max_matches || 100, next = null;
    const startSection = options.cursor?.section_index || 0;
    for (let sectionIndex = startSection; sectionIndex < sections.length; sectionIndex++) {
      const section = sections[sectionIndex];
      const lines = (await getText(section.id)).split(/\r\n|\n|\r/);
      for (let index = sectionIndex === startSection ? options.cursor?.line || 0 : 0; index < lines.length; index++) {
        const line = lines[index], column = (options.case_sensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
        if (column < 0) continue;
        if (!remaining) { next = { section_index: sectionIndex, line: index }; break; }
        matches.push({ section: section.id, line: index + 1, column: column + 1,
          snippet: line.slice(Math.max(0, column - 80), column + options.query.length + 120) }); remaining--;
      }
      if (next) break;
    }
    return { matches, truncated: Boolean(next), next_cursor: next };
  }
  throw new Error("Unknown document operation.");
}

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  let request;
  try {
    request = JSON.parse(line);
    const value = await action(request.operation, request.options || {});
    process.stdout.write(JSON.stringify({ id: request.id, value }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ id: request?.id, error: error.message }) + "\n"); }
}
