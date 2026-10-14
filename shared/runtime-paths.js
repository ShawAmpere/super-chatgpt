import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

let local = {};
try { local = JSON.parse(readFileSync(new URL('./runtime.local.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

export const runtimeRoot = () => process.env.LOCAL_MCP_RUNTIME_ROOT || local.runtime_root ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SuperChatGPT');
export const stateDirectory = name => path.join(runtimeRoot(), '.runtime', name);
export function resolveExecutable(name) {
  if (path.isAbsolute(name)) return name;
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const extension of process.platform === 'win32' ? ['', '.exe'] : ['']) {
      const candidate = path.join(directory, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return name;
}
export const pythonExecutable = () => resolveExecutable(process.env.LOCAL_FILE_READER_PYTHON ||
  process.env.SUPER_CHATGPT_PYTHON || local.python || (process.platform === 'win32' ? 'python.exe' : 'python3'));
