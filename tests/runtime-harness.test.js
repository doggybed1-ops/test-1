import test from 'node:test';
import assert from 'node:assert/strict';
import {executeDetailed} from './runtime.js';
import {obfuscate} from '../engine/index.js';

test('isolated runtimes catch pcall/xpcall errors and preserve success metadata', async () => {
  const source='local a,b=pcall(function()error("caught",0)end);local c,d=xpcall(function()error("handled",0)end,function(e)return e.."!" end);return a,b,c,d';
  for(const runtime of ['lua51','lua53','luau']) {
    const original=await executeDetailed(source,runtime);
    assert.equal(original.succeeded,true);
    assert.ok(original.result.includes('b:false'));
    const protectedCode=obfuscate({source,dialect:runtime,seed:'protected-call-harness'}).code;
    assert.deepEqual(await executeDetailed(protectedCode,runtime),original);
    const failure=await executeDetailed('error("uncaught",0)',runtime);
    assert.equal(failure.succeeded,false);
    assert.ok(failure.result.includes('756e636175676874'));
  }
});
