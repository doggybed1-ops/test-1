import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server/index.js';
import {CompilerPool} from '../server/pool.js';
const silent={info(){},error(){}};
test('API auth, limits, compilation, truthful diagnostics, no source logging',{timeout:30000},async()=>{
  const logs=[];const server=createApp({token:'test-token',rateLimit:100,logger:{info:v=>logs.push(v),error:v=>logs.push(v)}});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(body,token='test-token')=>fetch(base+'/api/obfuscate',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  try {
    assert.equal((await fetch(base+'/health')).status,200);
    const caps=await(await fetch(base+'/api/capabilities')).json();assert.equal(caps.features.customVM,true);
    assert.equal((await post({source:'return 1'},'wrong')).status,401);
    const response=await post({source:'return "secret-user-source-value",42',profile:'maximum'});assert.equal(response.status,200);
    const result=await response.json();assert.ok(result.code);assert.equal(result.compatibility.executionValidated,false);
    assert.ok(!logs.join('').includes('secret-user-source-value'));
    assert.equal((await post({source:'local ='})).status,422);
    assert.equal((await post({source:'return 1',seed:'public-seed-denied'})).status,400);
    assert.equal((await post({source:'a'.repeat(524289)})).status,422);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('rate limiting enforces the configured budget',async()=>{
  const server=createApp({rateLimit:1,logger:silent});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const send=()=>fetch(base+'/api/obfuscate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'return 1'})});
    assert.equal((await send()).status,200);const limited=await send();assert.equal(limited.status,429);assert.ok(limited.headers.has('retry-after'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('worker queue rejects overload',async()=>{
  const pool=new CompilerPool({concurrency:1,maxQueue:0});
  try {const first=pool.run({source:'return 1'});await assert.rejects(pool.run({source:'return 2'}),{code:'SERVICE_BUSY'});await first;}
  finally{await pool.close();}
});
test('queued work shares the admission deadline and can be cancelled',{timeout:5000},async()=>{
  const pool=new CompilerPool({concurrency:1,timeout:1,maxQueue:3});
  try {
    const started=Date.now();
    const results=await Promise.allSettled([pool.run({source:'return 1'}),pool.run({source:'return 2'}),pool.run({source:'return 3'})]);
    assert.ok(Date.now()-started<1000);
    for(const result of results){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'COMPILATION_TIMEOUT');}
    assert.equal(pool.queue.length,0);assert.equal(pool.jobs.size,0);
  }finally{await pool.close();}
  const cancellable=new CompilerPool({concurrency:1});const controller=new AbortController();
  try{const job=cancellable.run({source:'return 1'},{signal:controller.signal});controller.abort();await assert.rejects(job,{code:'REQUEST_CANCELLED'});assert.equal(cancellable.jobs.size,0);}
  finally{await cancellable.close();}
});
test('worker construction failure releases the admitted job',async()=>{
  const pool=new CompilerPool({workerURL:42});
  try{await assert.rejects(pool.run({source:'return 1'}),{code:'WORKER_FAILED'});assert.equal(pool.active,0);assert.equal(pool.jobs.size,0);assert.equal(pool.queue.length,0);}
  finally{await pool.close();}
});
