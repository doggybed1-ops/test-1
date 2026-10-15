import {Worker} from 'node:worker_threads';
export function executeDetailed(source,runtime='lua51',timeout=10000) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('../scripts/runtime-worker.js',import.meta.url),{workerData:{source,runtime},resourceLimits:{maxOldGenerationSizeMb:256}});
    let done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate().catch(()=>{});if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>finish(new Error(`${runtime} execution timed out`)),timeout);
    worker.once('message',message=>message.error?finish(new Error(message.error)):finish(null,{result:message.result,succeeded:message.succeeded}));
    worker.once('error',error=>finish(error));worker.once('exit',code=>{if(!done)finish(new Error(`Runtime exited: ${code}`));});
  });
}
export async function execute(source,runtime='lua51',timeout=10000) {
  return (await executeDetailed(source,runtime,timeout)).result;
}
