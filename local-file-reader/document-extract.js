import path from "node:path";

const maxXmlBytes = 16 * 1024 * 1024;
const prepared = new WeakMap();
function cached(buffer, key, create) {
  let state = prepared.get(buffer);
  if (!state) { state = {}; prepared.set(buffer, state); }
  return state[key] ||= create();
}

async function pdfDocument(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return cached(buffer, "pdf", () => pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true,
    disableFontFace: true, isEvalSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise);
}

export function documentArchive(buffer) {
  return cached(buffer, 'archive', async () => {
    const { default: JSZip } = await import('jszip');
    return JSZip.loadAsync(buffer);
  });
}

async function xlsxWorkbook(buffer) {
  const { default: ExcelJS } = await import("exceljs");
  return cached(buffer, "xlsx", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
  });
}

async function pptxSlides(buffer) {
  return cached(buffer, "pptx", async () => {
    const archive = await documentArchive(buffer);
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
    const presentation = archive.file("ppt/presentation.xml"), relations = archive.file("ppt/_rels/presentation.xml.rels");
    if (!presentation || !relations) throw new Error("Presentation is missing its authoritative slide order.");
    const source = await presentation.async("string"), relSource = await relations.async("string");
    if (/<!DOCTYPE|<!ENTITY/i.test(source + relSource)) throw new Error("DTD declarations are not supported.");
    const root = parser.parse(source), rel = parser.parse(relSource);
    const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
    const targets = new Map(array(rel.Relationships?.Relationship).map((item) => [item["@_Id"], item]));
    const names = array(root["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"]).map((slide) => {
      const relation = targets.get(slide["@_r:id"]);
      if (!relation || relation["@_TargetMode"] === "External") throw new Error("Invalid slide relationship.");
      const target = relation["@_Target"];
      const name = target.startsWith("/") ? target.slice(1) : path.posix.normalize("ppt/" + target);
      if (!archive.file(name)) throw new Error("Presentation slide part is missing.");
      return name;
    });
    return { archive, names };
  });
}

async function epubBook(buffer) {
  return cached(buffer, "epub", async () => {
    const { XMLParser } = await import("fast-xml-parser");
    const archive = await documentArchive(buffer);
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false, removeNSPrefix: true });
    const readXml = async (name) => {
      const entry = archive.file(name);
      if (!entry || entry._data?.uncompressedSize > maxXmlBytes) throw new Error("Invalid or oversized EPUB XML.");
      const xml = await entry.async("string");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD declarations are not supported.");
      return parser.parse(xml);
    };
    const container = await readXml("META-INF/container.xml");
    const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
    const opf = array(container.container?.rootfiles?.rootfile)[0]?.["@_full-path"];
    if (!opf) throw new Error("EPUB package is missing.");
    const book = (await readXml(opf)).package;
    const manifest = new Map(array(book.manifest?.item).map((item) => [item["@_id"], item["@_href"]]));
    const names = array(book.spine?.itemref).map((item) => {
      const href = manifest.get(item["@_idref"]);
      if (!href || /^\w+:/.test(href)) throw new Error("Invalid EPUB spine reference.");
      return path.posix.normalize(path.posix.dirname(opf) + "/" + decodeURIComponent(href.split("#")[0]));
    });
    return { archive, names };
  });
}

async function epubText(buffer, index) {
  const { archive, names } = await epubBook(buffer), name = names[index];
  if (!name) throw new Error("Unknown EPUB chapter.");
  const entry = archive.file(name);
  if (!entry || entry._data?.uncompressedSize > maxXmlBytes) throw new Error("EPUB chapter exceeds extraction limits.");
  const html = await entry.async("string");
  const { XMLParser } = await import("fast-xml-parser");
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false, preserveOrder: true });
  const nodes = parser.parse(html.replace(/<!DOCTYPE[^>]*>/gi, ""));
  const text = [];
  const collect = (value) => {
    if (Array.isArray(value)) { for (const item of value) collect(item); }
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (key === "#text") text.push(String(child));
      else if (!["script", "style"].includes(key)) { collect(child); if (["p", "div", "h1", "h2", "h3", "li", "br"].includes(key)) text.push("\n"); }
    }
  };
  collect(nodes); return text.join("");
}

function collectSlideText(value, lines) {
  if (Array.isArray(value)) {
    for (const child of value) collectSlideText(child, lines);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "a:t") lines.push(String(child));
      else collectSlideText(child, lines);
    }
  }
}

function cellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object" && "formula" in value) {
    return "=" + value.formula + (value.result == null ? "" : " [result: " + value.result + "]");
  }
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if (value instanceof Date) return value.toISOString();
  return cell.text || String(value);
}

async function pdfPageText(pdf, number) {
  const page = await pdf.getPage(number);
  const content = await page.getTextContent();
  let result = "";
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    result += item.str;
    result += item.hasEOL ? "\n" : " ";
  }
  return result.trim();
}

function sheetText(sheet) {
  const lines = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cellText(cell);
      if (value) cells.push(cell.address + "=" + value.replace(/\r?\n/g, " "));
    });
    if (cells.length) lines.push("Row " + rowNumber + ": " + cells.join(" | "));
  });
  return lines.join("\n");
}

async function slideText(archive, name) {
  const entry = archive.file(name);
  if (entry._data?.uncompressedSize > maxXmlBytes) throw new Error("Slide XML exceeds the extraction limit.");
  const xml = await entry.async("string");
  if (Buffer.byteLength(xml) > maxXmlBytes) throw new Error("Slide XML exceeds the extraction limit.");
  const { XMLParser } = await import("fast-xml-parser");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD declarations are not supported.");
  const tree = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false, processEntities: true }).parse(xml);
  const lines = [];
  collectSlideText(tree, lines);
  return lines.join("\n");
}

export async function getDocumentSections(format, buffer) {
  if ([".zip", ".jar", ".whl"].includes(format)) {
    const archive = await documentArchive(buffer);
    return Object.values(archive.files).filter((entry) => !entry.dir).map((entry) => ({
      id: "entry:" + entry.name, label: entry.name, size_bytes: entry._data?.uncompressedSize || 0,
    }));
  }
  if (format === ".epub") {
    const { names } = await epubBook(buffer);
    return names.map((name, index) => ({ id: "chapter:" + (index + 1), label: "Chapter " + (index + 1), part: name }));
  }
  if (format === ".pdf") {
    const pdf = await pdfDocument(buffer);
    try {
      return Array.from({ length: pdf.numPages }, (_, index) => ({
        id: "page:" + (index + 1), label: "Page " + (index + 1),
      }));
    } finally { /* Released with the isolated worker. */ }
  }
  if (format === ".docx") return [{ id: "body", label: "Document body" }];
  if (format === ".xlsx") {
    const workbook = await xlsxWorkbook(buffer);
    return workbook.worksheets.map((sheet) => ({
      id: "sheet:" + sheet.name, label: sheet.name, rows: sheet.rowCount,
      columns: sheet.columnCount,
    }));
  }
  if (format === ".pptx") {
    const { names } = await pptxSlides(buffer);
    return names.map((name, index) => ({ id: "slide:" + (index + 1), label: "Slide " + (index + 1), part: name }));
  }
  throw new Error("Unsupported document format.");
}

export async function getDocumentSectionText(format, buffer, section) {
  if ([".zip", ".jar", ".whl"].includes(format)) {
    const archive = await documentArchive(buffer);
    if (!section.startsWith("entry:")) throw new Error("Unknown archive entry.");
    const entry = archive.file(section.slice(6));
    if (!entry || entry._data?.uncompressedSize > 8 * 1024 * 1024) throw new Error("Archive entry is missing or exceeds the 8 MiB text limit.");
    const bytes = await entry.async("nodebuffer");
    if (bytes.subarray(0, 4096).includes(0) && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff)) throw new Error("Archive member is binary; only text extraction is supported for members.");
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { if (encoding !== "utf-8") throw new Error("Invalid encoded archive member."); return new TextDecoder("gb18030", { fatal: true }).decode(bytes); }
  }
  if (format === ".epub") {
    const number = Number(/^chapter:(\d+)$/.exec(section)?.[1]);
    if (!Number.isInteger(number) || number < 1) throw new Error("Unknown EPUB chapter.");
    return epubText(buffer, number - 1);
  }
  if (format === ".pdf") {
    const number = Number(/^page:(\d+)$/.exec(section)?.[1]);
    const pdf = await pdfDocument(buffer);
    try {
      if (!Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new Error("Unknown PDF page.");
      return await pdfPageText(pdf, number);
    } finally { /* Released with the isolated worker. */ }
  }
  if (format === ".docx") {
    if (section !== "body") throw new Error("Unknown Word section.");
    const { default: mammoth } = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (format === ".xlsx") {
    if (!section.startsWith("sheet:")) throw new Error("Unknown spreadsheet section.");
    const workbook = await xlsxWorkbook(buffer);
    const sheet = workbook.getWorksheet(section.slice(6));
    if (!sheet) throw new Error("Unknown spreadsheet sheet.");
    return sheetText(sheet);
  }
  if (format === ".pptx") {
    const number = Number(/^slide:(\d+)$/.exec(section)?.[1]);
    if (!Number.isInteger(number) || number < 1) throw new Error("Unknown PowerPoint slide.");
    const { archive, names } = await pptxSlides(buffer);
    const name = names[number - 1];
    if (!name) throw new Error("Unknown PowerPoint slide.");
    return slideText(archive, name);
  }
  throw new Error("Unsupported document format.");
}



