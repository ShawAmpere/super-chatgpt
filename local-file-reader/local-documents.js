import { documentRequest } from "./document-runtime.js";

export const documentFormats = new Set([
  ".pdf", ".docx", ".docm", ".dotx", ".dotm", ".doc", ".dot", ".rtf", ".odt", ".ott",
  ".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".xlsb", ".xlt", ".ods", ".ots",
  ".pptx", ".pptm", ".ppsx", ".potx", ".ppt", ".pps", ".pot", ".odp", ".otp", ".epub",
  ".zip", ".jar", ".whl",
]);

export async function readLocalDocument({ path, section, offset = 0, max_chars = 12000, index_limit = 100 }) {
  return documentRequest(path, section ? "section" : "index", { section, offset, max_chars, index_limit });
}
export async function searchDocument(path, options) { return documentRequest(path, "search", options); }
