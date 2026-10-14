export function validateToolList(tools, allowedNames) {
  const allowed = new Set(allowedNames), seen = new Set();
  for (const { name } of tools) {
    if (!allowed.has(name) || seen.has(name)) throw new Error("Unapproved or duplicate backend tool: " + name);
    seen.add(name);
  }
  return tools;
}

export class ToolCache {
  constructor() {this.entries=new Map();this.generations=new Map();this.pending=new Map();}
  invalidate(id) {this.generations.set(id,(this.generations.get(id)||0)+1);this.entries.delete(id);this.pending.delete(id);}
  async get(id, load, refreshes = 0) {
    if(this.entries.has(id))return this.entries.get(id);
    if(this.pending.has(id))return this.pending.get(id);
    const generation=this.generations.get(id)||0;
    const request=Promise.resolve().then(load).then(value=>{
      if((this.generations.get(id)||0)===generation)this.entries.set(id,value);
      if((this.generations.get(id)||0)!==generation) {
        if(refreshes<1)return this.get(id,load,refreshes+1);
        throw new Error('Tool discovery changed repeatedly during this request; refresh the list.');
      }
      return value;
    }).finally(()=>{if(this.pending.get(id)===request)this.pending.delete(id);});
    this.pending.set(id,request);return request;
  }
}
