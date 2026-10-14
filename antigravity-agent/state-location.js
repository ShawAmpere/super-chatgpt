import os from 'node:os';
import path from 'node:path';
import { readdir, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readJson, atomicWrite } from './task-store.js';
import { stateLock } from './state-lock.js';
import { activeTasks, activeRegistry } from './active-state.js';
import { stateDirectory } from '../shared/runtime-paths.js';

export const sharedAgentRoot = () => stateDirectory('antigravity-agent');
export const agentStateRoot = () => process.env.ANTIGRAVITY_AGENT_STATE_DIR || sharedAgentRoot();
export async function legacyAgentRoots() {
  const profile=process.env.USERPROFILE||os.homedir();
  const roots=[path.join(profile,'plugins','.runtime','antigravity-agent'),path.join(process.env.LOCALAPPDATA||path.join(profile,'AppData','Local'),'Codex','plugins','antigravity-agent')];
  if(process.platform==='win32') {
    const packages=path.join(profile,'AppData','Local','Packages');
    for(const name of await readdir(packages).catch(()=>[]))if(/^OpenAI\.Codex_/i.test(name))roots.push(path.join(packages,name,'LocalCache','Local','Codex','plugins','antigravity-agent'));
  }
  return [...new Set(roots)];
}
// Run under the destination OS lock. Explicit custom state paths stay isolated.
// Originals are retained; conflicting IDs or live legacy owners block migration.
export async function migrateAgentState(store, python, support, env, roots) {
  if(path.resolve(store.root).toLowerCase()!==path.resolve(sharedAgentRoot()).toLowerCase() && !roots)return;
  for(const root of roots || await legacyAgentRoots()) {
    if(path.resolve(root).toLowerCase()===path.resolve(store.root).toLowerCase())continue;
    try {await stat(path.join(root,'tasks'));} catch(error) {if(error.code==='ENOENT')continue;throw error;}
    const marker=path.join(store.root,'.migration-'+createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16)+'.json');
    if(await readJson(marker))continue;
    const legacyLock=stateLock(python,support,path.join(root,'state.guard'),env);
    try {await legacyLock.run(async()=>{
      const active=activeTasks(await readJson(path.join(root,'active.json')));
      for(const item of Object.values(active)) {
        if(!Number.isInteger(item.ownerPid)||item.ownerPid<1)throw new Error('Legacy Agent ownership is ambiguous; preserve and inspect the registry before migration.');
        let alive=false;try {process.kill(item.ownerPid,0);alive=true;}catch(error){alive=error.code==='EPERM';}
        if(alive)throw new Error(`Legacy Agent state has a live owner at ${root}. Finish its tasks and restart existing connections before migration, or explicitly keep ANTIGRAVITY_AGENT_STATE_DIR at that path.`);
      }
      let copied=0;
      for(const directory of ['tasks','messages']) {
        await mkdir(path.join(store.root,directory),{recursive:true});
        for(const name of await readdir(path.join(root,directory)).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
          if(!/^[0-9a-f-]{36}\.json$/i.test(name))continue;
          const source=await readJson(path.join(root,directory,name));
          const destination=path.join(store.root,directory,name),existing=await readJson(destination);
          if(existing && JSON.stringify(existing)!==JSON.stringify(source))throw new Error(`Conflicting legacy task data: ${name}. Both copies have been preserved.`);
          if(!existing) {await atomicWrite(destination,source);copied++;}
        }
      }
      const current=activeTasks(await readJson(path.join(store.root,'active.json')));
      for(const [id,item] of Object.entries(active)) {if(current[id]&&JSON.stringify(current[id])!==JSON.stringify(item))throw new Error('Conflicting active registry during state migration.');current[id]=item;}
      if(Object.keys(active).length)await atomicWrite(path.join(store.root,'active.json'),activeRegistry(current));
      if(copied)await store.rebuildRecent();
      await atomicWrite(marker,{source:root,copied,at:new Date().toISOString()});
    });} finally {await legacyLock.close();}
  }
}
