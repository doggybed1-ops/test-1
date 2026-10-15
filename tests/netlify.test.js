import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import proxy from '../netlify/functions/api.mjs';
import {createApp} from '../server/index.js';
test('Netlify proxy returns real authenticated compiler results and clear config errors',{timeout:15000},async()=>{
  const previousURL=process.env.PROCESSOR_URL,previousToken=process.env.PROCESSOR_TOKEN;
  delete process.env.PROCESSOR_URL;delete process.env.PROCESSOR_TOKEN;
  const server=createApp({token:'server-only-secret',logger:{info(){},error(){}}});server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const request=()=>new Request('https://workbench.example/api/obfuscate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'return "proxy test",42',profile:'maximum'})});
    const missing=await proxy(request(),{ip:'192.0.2.8'});assert.equal(missing.status,503);assert.equal((await missing.json()).error.code,'PROCESSOR_NOT_CONFIGURED');
    process.env.PROCESSOR_URL=`http://127.0.0.1:${server.address().port}`;process.env.PROCESSOR_TOKEN='server-only-secret';
    const response=await proxy(request(),{ip:'192.0.2.8'});assert.equal(response.status,200);const result=await response.json();
    assert.ok(result.passes.includes('register-vm'));assert.equal(result.compatibility.syntaxValidated,true);assert.ok(!JSON.stringify(result).includes('server-only-secret'));
    const caps=await proxy(new Request('https://workbench.example/api/capabilities'),{ip:'192.0.2.8'});assert.equal(caps.status,200);
    process.env.PROCESSOR_TOKEN='wrong';assert.equal((await proxy(request(),{ip:'192.0.2.8'})).status,401);
  }finally{
    if(previousURL===undefined)delete process.env.PROCESSOR_URL;else process.env.PROCESSOR_URL=previousURL;
    if(previousToken===undefined)delete process.env.PROCESSOR_TOKEN;else process.env.PROCESSOR_TOKEN=previousToken;
    await new Promise(resolve=>server.close(resolve));
  }
});
