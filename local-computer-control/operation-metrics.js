// Bounded, in-memory timings only: never retain text, clipboard data or images.
export class OperationMetrics {
  constructor(limit=40) { this.limit=limit; this.recent=[]; this.count=0; }
  record(value) { this.count++; this.recent.push(value); if(this.recent.length>this.limit)this.recent.shift(); }
  summary() {
    const groups={};
    for(const item of this.recent) {
      const kind=item.action||item.detail||item.condition;
      const key=item.operation+(kind?':'+kind:'');
      const group=groups[key]??={values:[],failures:0};
      if(item.is_error)group.failures++;else group.values.push(item.elapsed_ms);
    }
    const percentiles={};
    for(const [operation,{values,failures}] of Object.entries(groups)){
      values.sort((a,b)=>a-b);
      percentiles[operation]={samples:values.length,failed_samples:failures,p50_ms:values.length?values[Math.ceil(values.length*.5)-1]:null,p95_ms:values.length?values[Math.ceil(values.length*.95)-1]:null};
    }
    return {scope:'local broker only; excludes Chat reasoning and tunnel network',total_calls:this.count,recent:[...this.recent],percentiles};
  }
}
