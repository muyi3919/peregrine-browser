'use strict';
const { EventEmitter } = require('node:events');
class CdpPipe extends EventEmitter {
  constructor(input, output) {
    super();
    this.input=input; this.output=output; this.nextId=1; this.pending=new Map(); this.buffer=Buffer.alloc(0); this.closed=false;
    output.on('data', chunk => {
      this.buffer=Buffer.concat([this.buffer,chunk]);
      let end;
      while ((end=this.buffer.indexOf(0)) >= 0) {
        const line=this.buffer.subarray(0,end).toString('utf8'); this.buffer=this.buffer.subarray(end+1);
        if(!line) continue;
        let message; try { message=JSON.parse(line); } catch { this.close(); return; }
        if(message.id) {
          const pending=this.pending.get(message.id); if(!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if(message.error) {const error=new Error(`浏览器控制命令失败：${pending.method}`);error.protocolError=message.error;pending.reject(error);} else pending.resolve(message.result || {});
        } else this.emit('event',message);
      }
      if(this.buffer.length > 32*1024*1024) this.close();
    });
    output.on('close',()=>this.close()); output.on('error',()=>this.close()); input.on('error',()=>this.close());
  }
  send(method,params={},sessionId) {
    if(this.closed) return Promise.reject(new Error('浏览器控制管道已关闭。'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`浏览器控制命令超时：${method}`));},15000);
      this.pending.set(id,{resolve,reject,timer,method});
      this.input.write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0',error=>{
        if(error) {this.pending.delete(id);clearTimeout(timer);reject(new Error('浏览器控制管道写入失败。'));}
      });
    });
  }
  close() {
    if(this.closed) return;
    this.closed=true;
    for(const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(new Error(`浏览器控制管道已关闭：${pending.method}`));}
    this.pending.clear(); this.emit('close');
  }
}
module.exports={CdpPipe};
