import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A single sequential request channel. A lost reply invalidates the worker;
// operations are never replayed automatically.
export class JsonLineWorker {
  constructor(command, args, options = {}) { this.command=command; this.args=args; this.options=options; this.tail=Promise.resolve(); this.starts=0; this.sequence=0; }
  start() {
    if (this.child) return;
    const child = spawn(this.command,this.args,{...this.options,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child; this.starts++; this.diagnostics='';
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{if(this.child!==child)return;try {const reply=JSON.parse(line); const pending=this.pending; if(!pending || reply._request_id!==pending.id) throw new Error('Unexpected or mismatched worker reply.'); this.pending=null; reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply);} catch(error) {this.invalidate(error);} });
    child.stderr.on('data',chunk=>{this.diagnostics=(this.diagnostics+chunk).slice(-2000);});
    child.stdin.on('error',error=>this.invalidate(error));
    child.once('error',error=>this.invalidate(error));
    child.once('close',()=>{lines.close();if(this.child===child) this.invalidate(new Error(this.diagnostics||'Worker stopped.'));});
  }
  invalidate(error) {
    const child=this.child;this.child=null; const pending=this.pending;this.pending=null;pending?.reject(error);child?.kill();
  }
  request(value, timeout=10000) {
    const run=async()=>{
      this.start();
      let timer;
      const id=++this.sequence;
      try {return await new Promise((resolve,reject)=>{this.pending={resolve,reject,id};timer=setTimeout(()=>this.invalidate(new Error('Worker response timed out.')),timeout);try {this.child.stdin.write(JSON.stringify({...value,_request_id:id})+'\n');}catch(error){this.invalidate(error);}});}
      finally {clearTimeout(timer);}
    };
    const result=this.tail.then(run);this.tail=result.catch(()=>{});return result;
  }
  async close() {await this.tail;const child=this.child;this.child=null;if(!child)return;await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},2000);child.once('close',()=>{clearTimeout(timer);resolve();});child.stdin.end();});}
}
