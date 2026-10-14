import { pythonExecutable, stateDirectory } from '../shared/runtime-paths.js';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const basePython = pythonExecutable;
export const editorPython = () => process.env.LOCAL_DOCUMENT_EDITOR_PYTHON || path.join(stateDirectory('document-editor'), 'Scripts/python.exe');
export const editorScript = fileURLToPath(new URL('./document-editor.py', import.meta.url));
export const editorFormats = ['.docx', '.pdf', '.pptx', '.xlsx', '.odt', '.ods', '.odp', '.rtf', '.doc', '.xls', '.ppt', '.csv', '.tsv', '.txt', '.md', '.html'];
let cached;
export async function editorCapabilities() {
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const installed = await access(editorPython()).then(() => true, () => false);
  let value = { available: false, setup: 'Run local-file-reader/scripts/setup-editor.ps1.', formats: editorFormats };
  if (installed) {
    try {
      const { stdout } = await promisify(execFile)(editorPython(), [editorScript, 'capabilities'], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
      value = { ...value, ...JSON.parse(stdout), python: editorPython() };
    } catch (error) { value.error = error.message; }
  }
  cached = { at: Date.now(), value }; return value;
}
