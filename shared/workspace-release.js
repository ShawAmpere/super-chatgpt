import { lstat, readFile, realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const read = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const inside = (root, file) => { const relative=path.relative(root,file);return relative!=='' && !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative); };
async function stableHash(root, relative) {
  const file=path.resolve(root,relative), canonicalRoot=await realpath(root);
  if(!inside(root,file) || (await lstat(root)).isSymbolicLink())throw Error('path escaped component root');
  const info=await lstat(file,{bigint:true});
  if(!info.isFile() || info.isSymbolicLink() || !inside(canonicalRoot,await realpath(file)))throw Error('not a regular owned file');
  const handle=await open(file,'r');
  try {
    const opened=await handle.stat({bigint:true});if(opened.ino!==info.ino || opened.dev!==info.dev)throw Error('file identity changed');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(65536);let position=0;
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;digest.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
    const after=await lstat(file,{bigint:true});
    if(after.isSymbolicLink() || after.ino!==info.ino || after.dev!==info.dev || after.size!==info.size || after.mtimeNs!==info.mtimeNs || after.ctimeNs!==info.ctimeNs || !inside(canonicalRoot,await realpath(file)))throw Error('file changed during hashing');
    return digest.digest('hex');
  } finally {await handle.close();}
}
export async function verifyRuntimeIntegrity(base, names) {
  let checked = 0, failures = 0;
  const mismatches = [];
  const fail = item => { failures++; if (mismatches.length < 20) mismatches.push(item); };
  for (const name of names) {
    const root = path.resolve(base, name);
    let manifest;
    try { manifest = await read(path.join(root, '.release-manifest.json')); }
    catch { fail(name + ': unreadable release manifest'); continue; }
    if (!manifest || manifest.version !== 2 || !manifest.files) { fail(name + ': missing release manifest'); continue; }
    for (const [relative, expected] of Object.entries(manifest.files)) {
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !/^[a-f0-9]{64}$/i.test(expected)) {
        fail(name + '/' + relative + ': invalid manifest path or digest'); continue;
      }
      try {
        const digest = await stableHash(root, relative);
        checked++;
        if (digest.toLowerCase() !== expected.toLowerCase()) fail(name + '/' + relative + ': hash mismatch');
      } catch { fail(name + '/' + relative + ': missing or unreadable'); }
    }
  }
  return { verified: failures === 0, checked_files: checked, issue_count: failures,
    issues: mismatches, truncated: failures > mismatches.length,
    scope: 'Release-manifest managed files only', excludes: ['node_modules unless verify_dependencies is requested','unmanaged additions','external Node/Python/CLI/LibreOffice and Windows'] };
}

export async function verifyDependencies(base,names) {
  const issues=[];let checked=0,critical=0,skipped=0;
  const applicable=(values,actual)=>!values?.length || !values.includes('!'+actual) && (values.every(value=>value.startsWith('!')) || values.includes(actual));
  for(const name of names) {
    const root=path.join(base,name),lock=await read(path.join(root,'package-lock.json'));
    if(!lock)continue;
    for(const [relative,item] of Object.entries(lock.packages||{})) {
      if(!relative.startsWith('node_modules/'))continue;
      if(!applicable(item.os,process.platform) || !applicable(item.cpu,process.arch)){skipped++;continue;}
      const file=path.resolve(root,relative,'package.json');
      if(!inside(root,file)) {issues.push(name+': dependency path escaped');continue;}
      try {const installed=await read(file);if(!installed && item.optional){skipped++;continue;}checked++;if(installed?.version!==item.version)issues.push(name+'/'+relative+': dependency version mismatch');}catch {issues.push(name+'/'+relative+': dependency metadata unavailable');}
    }
    const manifest=await read(path.join(root,'.release-manifest.json'));
    if(!manifest?.dependency_files)issues.push(name+': dependency content baseline unavailable; republish before deep validation');
    for(const [relative,expected] of Object.entries(manifest?.dependency_files||{})) {
      try {critical++;if(await stableHash(root,relative)!==expected.toLowerCase())issues.push(name+'/'+relative+': critical dependency hash mismatch');}catch {issues.push(name+'/'+relative+': critical dependency unavailable or changed');}
    }
  }
  return {verified:issues.length===0,checked_package_versions:checked,skipped_inapplicable_or_optional:skipped,checked_critical_files:critical,issue_count:issues.length,issues:issues.slice(0,20),truncated:issues.length>20,
    scope:'Applicable installed lockfile package versions plus published direct-package metadata and entry files; optional absence and other platforms excluded. Not a full dependency or external environment audit'};
}

export async function workspaceStatus(base, { verifyFiles = false, verifyDependencyFiles = false } = {}) {
  const issues = [], versions = {};
  let compatible = true;
  const policy = await read(path.join(base, 'shared/workspace-policy.json'));
  if (policy?.format !== 1) throw new Error('Workspace compatibility policy is missing or unsupported.');
  for (const [name, family] of Object.entries(policy.component_families)) {
    const pkg = await read(path.join(base, name, 'package.json'));
    versions[name] = pkg?.version || null;
    const parts = pkg?.version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
    const expected = family.split('.');
    if (!parts || parts[1] !== expected[0] || (expected[1] !== '*' && parts[2] !== expected[1]) ||
        (pkg.mcp_compatibility && (pkg.mcp_compatibility.shared_abi !== policy.shared_abi ||
          pkg.mcp_compatibility.broker_protocol !== policy.broker_protocol))) {
      compatible = false; issues.push('Incompatible component: ' + name);
    }
    if (await read(path.join(base, name, '.release-pending.json'))) {
      compatible = false; issues.push('Unrecovered module update: ' + name);
    }
  }
  const pending = await read(path.join(base, '.workspace-pending.json'));
  const release = await read(path.join(base, '.workspace-release.json'));
  let state = release ? 'consistent' : 'untracked';
  if (pending) {
    state = 'partial';
    issues.push('Workspace publication is incomplete; rerun the unified updater to finish it.');
  } else if (release && Object.entries(versions).some(([name, version]) => release.versions?.[name] !== version)) {
    state = 'out_of_manifest';
    issues.push('Compatible individual module updates differ from the last complete workspace release.');
  }
  const integrity = verifyFiles ? await verifyRuntimeIntegrity(base, Object.keys(policy.component_families)) : null;
  const dependencies = verifyDependencyFiles ? await verifyDependencies(base,Object.keys(policy.component_families)) : null;
  if (integrity && !integrity.verified) {
    issues.push('Managed runtime file integrity verification failed.');
    if (state === 'consistent') state = 'file_drift';
  }
  if (dependencies && !dependencies.verified) {issues.push('Dependency metadata or critical entry-file verification failed.');if(state==='consistent')state='dependency_drift';}
  return { compatible, state: compatible ? state : 'incompatible', versions, issues,
    ...(integrity ? { integrity } : {}),
    ...(dependencies ? { dependencies } : {}),
    release_id: release?.id || null, pending_release_id: pending?.id || null,
    shared_abi: policy.shared_abi, broker_protocol: policy.broker_protocol };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const status = await workspaceStatus(path.resolve(process.argv[2] || path.join(fileURLToPath(new URL('..', import.meta.url)))));
  console.log(JSON.stringify(status));
  if (!status.compatible) process.exitCode = 1;
}
