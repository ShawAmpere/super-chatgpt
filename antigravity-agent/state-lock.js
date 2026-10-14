import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JsonLineWorker } from '../shared/json-line-worker.js';

export function stateLock(python, support, file, env) {
  const worker=new JsonLineWorker(python,[support,'lock-server',file],{env});
  let tail=Promise.resolve();
  return {
    run(action) {
      const run=async()=>{
        await mkdir(path.dirname(file),{recursive:true});
        await worker.request({operation:'acquire',seconds:5});
        const child=worker.child;
        try {const value=await action();if(child!==worker.child) throw new Error('Task-state lock worker stopped during commit.');return value;}
        finally {if(child===worker.child) await worker.request({operation:'release'});}
      };
      const result=tail.then(run);tail=result.catch(()=>{});return result;
    },
    async close() {await tail;await worker.close();},
    get starts() {return worker.starts;},
  };
}
