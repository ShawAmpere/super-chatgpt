import { access, readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pythonExecutable, runtimeRoot } from './runtime-paths.js';
import { fileURLToPath } from 'node:url';
import { workspaceStatus } from './workspace-release.js';

async function inspect(file) {try {await access(file);return {path:file,available:true};}catch{return {path:file,available:false,next_action:'Restore the configured local executable; this check does not test account/model permission.'};}}
export async function environmentDiagnostics(base = runtimeRoot()) {
  let config={};try{config=JSON.parse(await readFile(path.join(process.env.LOCAL_COMPUTER_CONTROL_STATE_DIR||path.join(base,'.runtime/local-computer-control'),'runtime.json'),'utf8'));}catch{}
  const python=pythonExecutable();
  const values=await Promise.all([process.execPath,python,config.python||python,
    process.env.LOCAL_FILE_READER_LIBREOFFICE||'C:\\Program Files\\LibreOffice\\program\\soffice.exe'].map(inspect));
  return {read_only:true,node_version:process.version,executables:Object.fromEntries(['node','file_python','desktop_python','libreoffice'].map((name,index)=>[name,values[index]])),
    credential_check:'Not performed; no key is requested, read or returned',permission_check:'Executable availability does not establish operation permission'};
}

export async function storageInventory(base = runtimeRoot()) {
  const categories={release_backups:path.join(base,'.releases'),file_edit_backups:path.join(process.env.LOCAL_FILE_READER_STATE_DIR||path.join(base,'.runtime/local-file-reader'),'backups')};
  const result={read_only:true,automatic_cleanup:false,categories:{}};
  for(const [name,root] of Object.entries(categories)) {
    const summary={files:0,bytes:0,oldest_modified_at:null,newest_modified_at:null,skipped_links:0,unreadable:0,truncated:false};
    if(name==='file_edit_backups'){summary.backup_metadata=[];summary.associations_truncated=false;}
    const queue=[root];let oldest=Infinity,newest=0,visited=0;
    while(queue.length && visited<50000) {
      const directory=queue.pop();let info,entries;
      try{info=await lstat(directory);if(info.isSymbolicLink()){summary.skipped_links++;continue;}entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')summary.unreadable++;continue;}
      for(const entry of entries) {
        if(++visited>50000){summary.truncated=true;break;}
        const file=path.join(directory,entry.name);
        if(entry.isSymbolicLink()){summary.skipped_links++;continue;}
        if(entry.isDirectory()){queue.push(file);continue;}
        try{
          const info=await lstat(file);if(info.isSymbolicLink()){summary.skipped_links++;continue;}summary.files++;summary.bytes+=info.size;oldest=Math.min(oldest,info.mtimeMs);newest=Math.max(newest,info.mtimeMs);
          if(name==='file_edit_backups' && entry.name.endsWith('.metadata.json') && info.size<=65536){
            if(summary.backup_metadata.length>=20){summary.associations_truncated=true;continue;}
            const metadata=JSON.parse(await readFile(file,'utf8'));
            if(typeof metadata.source_path==='string' && metadata.source_path.length<2048 && /^[a-f0-9]{64}$/i.test(metadata.sha256))summary.backup_metadata.push({metadata_file:entry.name,source_path:metadata.source_path,sha256:metadata.sha256,created_at:typeof metadata.created_at==='string'?metadata.created_at.slice(0,64):null});
          }
        }catch{summary.unreadable++;}
      }
    }
    summary.truncated ||= queue.length>0;summary.oldest_modified_at=Number.isFinite(oldest)?new Date(oldest).toISOString():null;summary.newest_modified_at=newest?new Date(newest).toISOString():null;
    summary.note=name==='file_edit_backups'?'New backups have source metadata sidecars; legacy source associations remain unknown. No backup is deleted.'
      :'Deploymenter-owned, verified releases retain the existing guarded retention policy; this inventory deletes nothing.';
    result.categories[name]=summary;
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const base=path.resolve(process.argv[2]||path.join(fileURLToPath(new URL('..',import.meta.url))));
  console.log(JSON.stringify({environment:await environmentDiagnostics(base),deployment:await workspaceStatus(base),
    ...(process.argv.includes('--storage')?{storage:await storageInventory(base)}:{})},null,2));
}
