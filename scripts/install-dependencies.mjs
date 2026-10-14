import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = process.env.npm_execpath;
if (!cli) throw new Error('Invoke this script with npm run install:dependencies.');
for (const component of ['local-file-reader', 'local-computer-control', 'local-mcp-gateway']) {
  console.log(`Installing locked dependencies: ${component}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: path.join(root, component), windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('close', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
