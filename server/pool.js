import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

export class WorkError extends Error { constructor(code,message){super(message);this.code=code;} }
export class CompilerPool {
  constructor({concurrency=Math.min(2,availableParallelism()),timeout=15000,maxQueue=8,workerURL=new URL('./worker.js',import.meta.url)}={}) {
    this.concurrency=concurrency;this.timeout=timeout;this.maxQueue=maxQueue;this.workerURL=workerURL;this.active=0;this.queue=[];this.closed=false;this.workers=new Set();this.jobs=new Set();
  }
  run(input,{signal}={}) {
    if(this.closed)return Promise.reject(new WorkError('SERVICE_CLOSED','The compiler is shutting down.'));
    if(signal?.aborted)return Promise.reject(new WorkError('REQUEST_CANCELLED','The request was cancelled.'));
    if(this.active>=this.concurrency&&this.queue.length>=this.maxQueue)return Promise.reject(new WorkError('SERVICE_BUSY','The compiler is busy. Try again shortly.'));
    return new Promise((resolve,reject)=>{
      const job={input,worker:null,done:false};
      job.finish=(error,result)=>{
        if(job.done)return;job.done=true;clearTimeout(job.timer);signal?.removeEventListener('abort',job.abort);this.jobs.delete(job);job.input=null;
        const index=this.queue.indexOf(job);if(index>=0)this.queue.splice(index,1);
        if(error)reject(error);else resolve(result);
        if(job.worker){const worker=job.worker;this.workers.delete(worker);worker.terminate().catch(()=>{}).finally(()=>{this.active--;this.drain();});}
        else this.drain();
      };
      job.abort=()=>job.finish(new WorkError('REQUEST_CANCELLED','The request was cancelled.'));
      // The admission deadline covers queue wait, startup, and compilation.
      job.timer=setTimeout(()=>job.finish(new WorkError('COMPILATION_TIMEOUT','Compilation exceeded the 15-second request budget.')),this.timeout);
      signal?.addEventListener('abort',job.abort,{once:true});this.jobs.add(job);this.queue.push(job);this.drain();
    });
  }
  drain() {
    while(!this.closed&&this.active<this.concurrency&&this.queue.length) {
      const job=this.queue.shift();if(job.done)continue;let worker;
      try {worker=new Worker(this.workerURL,{workerData:job.input,resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:32,stackSizeMb:4}});}
      catch{job.finish(new WorkError('WORKER_FAILED','The compiler worker could not start.'));continue;}
      job.input=null;job.worker=worker;this.active++;this.workers.add(worker);
      worker.once('message',message=>{if(message.error){const error=new WorkError(message.error.code,message.error.message);Object.assign(error,message.error);job.finish(error);}else job.finish(null,message.result);});
      worker.once('error',error=>job.finish(new WorkError('WORKER_FAILED',error.code==='ERR_WORKER_OUT_OF_MEMORY'?'Compilation exceeded the worker memory limit.':'The compiler worker failed.')));
      worker.once('exit',code=>{if(!job.done)job.finish(new WorkError('WORKER_FAILED',`Compiler worker exited before returning a result (${code}).`));});
    }
  }
  async close() {
    this.closed=true;const workers=[...this.workers];
    for(const job of [...this.jobs])job.finish(new WorkError('SERVICE_CLOSED','The compiler is shutting down.'));
    await Promise.allSettled(workers.map(worker=>worker.terminate()));
  }
}
