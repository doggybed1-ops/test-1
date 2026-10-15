import {parentPort,workerData} from 'node:worker_threads';
import {obfuscate} from '../engine/index.js';
try { parentPort.postMessage({result:obfuscate(workerData)}); }
catch(error) { parentPort.postMessage({error:{code:error.code||'COMPILATION_FAILED',message:error.message,line:error.line,column:error.column===undefined?undefined:error.column+1}}); }
