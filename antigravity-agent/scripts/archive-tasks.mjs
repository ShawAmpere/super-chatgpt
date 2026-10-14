import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pythonExecutable } from '../../shared/runtime-paths.js';
import { TaskStore, readJson, atomicWrite } from '../task-store.js';
import { agentStateRoot } from '../state-location.js';
import { activeTasks } from '../active-state.js';
import { stateLock } from '../state-lock.js';

const days=Number(process.argv[2]||30);
const dryRun=process.argv.includes('--dry-run');
if(!Number.isFinite(days)||days<1)throw new Error('Archive age must be at least one day.');
const root=agentStateRoot(), store=new TaskStore(root);
const env={...process.env};delete env.CONTROL_PLANE_API_KEY;
const lock=stateLock(process.env.ANTIGRAVITY_AGENT_PYTHON||pythonExecutable(),fileURLToPath(new URL('../process-support.py',import.meta.url)),path.join(root,'state.guard'),env);
try {
  const archived=await lock.run(async()=>{
    const ids=await store.recent();
    const count=await store.archive(Date.now()-days*86400000,new Set(Object.keys(activeTasks(await readJson(path.join(root,'active.json'))))),{dryRun});
    if(!dryRun)await atomicWrite(store.index,{version:1,ids});return count;
  });
  console.log(JSON.stringify({archived:dryRun?0:archived,...(dryRun?{archive_candidates:archived,read_only:true}:{}),retention_days:days,history_preserved:true,state_root:root}));
} finally {await lock.close();}
