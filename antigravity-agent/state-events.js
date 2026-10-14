import { watch } from 'node:fs';
import path from 'node:path';

// Directory watches survive atomic JSON replacement. A slow fallback covers
// lost events. Filter by path so another task does not cause inbox polling.
export class StateEvents {
  constructor(directories) {
    this.epoch=0; this.versions=new Map(); this.listeners=new Set();
    this.watchers=directories.map(directory=>{
      try {const watcher=watch(directory,{persistent:false},(_,name)=>this.notify(name ? path.join(directory,String(name)) : null));watcher.on('error',()=>this.notify());return watcher;}
      catch {return null;}
    });
  }
  key(file) {return path.resolve(file).toLowerCase();}
  capture(file) {const key=this.key(file);if(!this.versions.has(key)){if(this.versions.size>=512){this.versions.clear();this.epoch++;}this.versions.set(key,0);}return `${this.epoch}:${this.versions.get(key)}`;}
  notify(file) {
    const key=file ? this.key(file) : null;
    if(key){if(this.versions.has(key))this.versions.set(key,this.versions.get(key)+1);}else this.epoch++;
    for(const item of [...this.listeners])if(!key||item.files.has(key))item.wake();
  }
  wait(file, version, ms, signal) {
    signal?.throwIfAborted();if(version!==this.capture(file))return Promise.resolve();
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);this.listeners.delete(item);signal?.removeEventListener('abort',abort);};
      const wake=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(signal.reason||new Error('Wait cancelled.'));};
      const item={files:new Set([this.key(file)]),wake};this.listeners.add(item);
      signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(wake,Math.max(1,ms));
      if(version!==this.capture(file))wake();else if(signal?.aborted)abort();
    });
  }
  subscribe(action, files) {const item={files:new Set(files.map(file=>this.key(file))),wake:()=>{void action();}};this.listeners.add(item);return()=>this.listeners.delete(item);}
  close() {for(const watcher of this.watchers)watcher?.close();this.notify();this.listeners.clear();}
}
