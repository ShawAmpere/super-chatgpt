import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { configurationFile } from '../shared/runtime-paths.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = process.env.npm_execpath;
if (!cli) throw new Error('Invoke this script with npm run install:dependencies.');
const policyFile = path.join(root, 'shared', existsSync(path.join(root, 'shared/workspace-policy.json')) ? 'workspace-policy.json' : 'workspace-policy.default.json');
const policy = JSON.parse(readFileSync(configurationFile('workspace-policy.json', policyFile), 'utf8'));
for (const component of Object.keys(policy.component_families)) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(component)) throw new Error('Invalid component name.');
  if (!existsSync(path.join(root, component, 'package-lock.json'))) continue;
  console.log(`Installing locked dependencies: ${component}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: path.join(root, component), windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('close', resolve);
  });
  if (code !== 0) process.exit(code || 1);
}
