import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  try {return JSON.parse(await readFile(file,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
export async function atomicWrite(file,value) {
  const temp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    const deadline=Date.now()+1000;
    for(let pause=10;;pause=Math.min(pause*2,100)) {
      try {await rename(temp,file);break;}
      catch(error) {
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||Date.now()>=deadline)throw error;
        // Retry only publication of these same bytes, never the enclosing action.
        await new Promise(resolve=>setTimeout(resolve,Math.min(pause,deadline-Date.now())));
      }
    }
  }
  finally {await rm(temp,{force:true}).catch(()=>{});}
}
export class TaskStore {
  constructor(root) {this.root=root;this.tasks=path.join(root,'tasks');this.index=path.join(root,'recent.json');}
  file(id) {if(!/^[0-9a-f-]{36}$/i.test(id))throw new Error('Invalid task id.');return path.join(this.tasks,`${id}.json`);}
  archiveFile(id) {this.file(id);return path.join(this.root,'archive',id.slice(0,2),`${id}.json`);}
  async read(id) {return await readJson(this.file(id)) || await readJson(this.archiveFile(id));}
  async resolvedFile(id) {try {await stat(this.file(id));return this.file(id);}catch(error){if(error.code!=='ENOENT')throw error;return this.archiveFile(id);}}
  async recent() {
    let saved;
    try { saved=await readJson(this.index); } catch(error) { if(!(error instanceof SyntaxError))throw error; }
    if(saved?.version===1 && Array.isArray(saved.ids) && !saved.ids.some(id=>!/^[0-9a-f-]{36}$/i.test(id)))return saved.ids;
    return this.rebuildRecent(false);
  }
  async records() {
    const names=(await readdir(this.tasks)).filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name));
    return names.map(name=>name.slice(0,-5));
  }
  async rebuildRecent(persist=true) {
    const names=(await readdir(this.tasks)).filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name));
    const entries=await Promise.all(names.map(async name=>({id:name.slice(0,-5),at:(await stat(path.join(this.tasks,name))).mtimeMs})));
    const ids=entries.sort((a,b)=>b.at-a.at).slice(0,256).map(item=>item.id);
    if(persist)await atomicWrite(this.index,{version:1,ids});return ids;
  }
  // Called under the shared OS lock. Keep progress writes out of the index.
  async save(record) {
    await atomicWrite(this.file(record.id),record);
    if(record.status==='starting'||record.finishedAt) {
      const ids=await this.recent();
      await atomicWrite(this.index,{version:1,ids:[record.id,...ids.filter(id=>id!==record.id)].slice(0,256)});
    }
  }
  async commit(record, updateActive) {
    // The durable result is the commit point. Never free an active slot before
    // its result exists. An interrupted registry update is reconciled on boot.
    await this.save(record);
    await updateActive();
  }
  // Explicit maintenance only. Never remove history; get_task still resolves it.
  async archive(olderThan, activeIds, {dryRun=false}={}) {
    const names=(await readdir(this.tasks)).filter(name=>/^[0-9a-f-]{36}\.json$/i.test(name));
    let count=0;
    for(const name of names) {
      const id=name.slice(0,-5);if(activeIds.has(id))continue;
      const record=await this.read(id);
      const finishedAt=Date.parse(record?.finishedAt);
      if(!['completed','failed','cancelled','timed_out','interrupted','needs_input'].includes(record?.status)||!Number.isFinite(finishedAt)||finishedAt>=olderThan||['pending','unknown'].includes(record.cleanupState))continue;
      const destination=this.archiveFile(id);if(await readJson(destination))throw new Error('Archive destination already exists; preserve both records and resolve the conflict.');
      if(dryRun){count++;continue;}
      await mkdir(path.dirname(destination),{recursive:true});await rename(this.file(id),destination);count++;
    }
    return count;
  }
}
