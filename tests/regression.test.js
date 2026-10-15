import test from 'node:test';
import assert from 'node:assert/strict';
import {obfuscate} from '../engine/index.js';
import {fixtures} from './fixtures.js';
import {execute,executeDetailed} from './runtime.js';
for(const [name,source] of fixtures) {
  test(`Lua 5.1 differential: ${name}`,{timeout:60000},async()=>{
    const baseline=await executeDetailed(source), original=baseline.result;
    assert.equal(baseline.succeeded,true,`Original fixture failed: ${original}`);
    for(const profile of ['standard','advanced','maximum']) {
      const result=obfuscate({source,profile,seed:`fixture:${name}`});
      assert.notEqual(result.code,source);assert.equal(result.compatibility.syntaxValidated,true);
      const protectedResult=await executeDetailed(result.code);
      assert.equal(protectedResult.succeeded,true);assert.equal(protectedResult.result,original,`${profile} behavior differs for ${name}`);
    }
  });
}
test('randomized builds hide source literals and use the real VM',()=>{
  const source=`local secret='UNIQUE_PRIVATE_LITERAL_57153' local function f(x)return x+1 end return secret,f(42)`;
  const a=obfuscate({source}),b=obfuscate({source});
  assert.notEqual(a.code,b.code);assert.ok(!a.code.includes('UNIQUE_PRIVATE_LITERAL_57153'));
  assert.ok(!a.code.includes('local secret'));assert.ok(!/loadstring\s*\(/.test(a.code));
  assert.ok(a.passes.some(pass=>/vm|virtual/i.test(pass)));assert.ok(a.stats.vmInstructions>0);
});
test('test seeds reproduce exact output without pinning production builds',()=>{
  const request={source:'return "hello",42',seed:'fixed'};
  assert.equal(obfuscate(request).code,obfuscate(request).code);
});
test('diagnostics reject unsupported syntax and environment reflection',()=>{
  for(const source of ['local x: number = 3','continue','x += 1'])assert.throws(()=>obfuscate({source,dialect:'luau'}),{code:'SYNTAX_ERROR'});
  for(const source of ['goto next ::next:: return 1','return 7 // 2','return 1 << 2'])assert.throws(()=>obfuscate({source,dialect:'lua53'}),{code:'UNSUPPORTED_FEATURE'});
  assert.throws(()=>obfuscate({source:'return debug.getinfo(1)'}),{code:'UNSUPPORTED_FEATURE'});
  assert.throws(()=>obfuscate({source:'return _ENV'}),{code:'UNSUPPORTED_FEATURE'});
  assert.throws(()=>obfuscate({source:'local ='}),{code:'SYNTAX_ERROR'});
  assert.throws(()=>obfuscate({source:'x'.repeat(524289)}),{code:'SOURCE_TOO_LARGE'});
  assert.throws(()=>obfuscate({source:'return 1',options:{pretend:true}}),{code:'INVALID_OPTIONS'});
  assert.throws(()=>obfuscate({source:'return 1',profile:['maximum']}),{code:'INVALID_PROFILE'});
  assert.throws(()=>obfuscate({source:'return 1',dialect:'__proto__'}),{code:'INVALID_DIALECT'});
  for(const source of ['return string.dump(function()return 1 end)','collectgarbage("collect")','local t=setmetatable({}, {__mode="v"})','local function f(...)return arg end return f(1)'])assert.throws(()=>obfuscate({source}),{code:'UNSUPPORTED_FEATURE'});
});
test('disabled protections are reported accurately',()=>{
  const result=obfuscate({source:'local value=4 return value',profile:'standard',options:{rename:true,stringProtection:false,constantProtection:false}});
  assert.ok(result.passes.some(pass=>/renam/i.test(pass)));assert.ok(!result.passes.some(pass=>/string|constant/i.test(pass)));
  assert.throws(()=>obfuscate({source:'return 1',profile:'standard',options:{rename:false,stringProtection:false,constantProtection:false}}),{code:'NO_TRANSFORMATIONS'});
});
test('large program compiles without source execution', {timeout:20000},()=>{
  const source='local total=0\n'+Array.from({length:2000},(_,i)=>`total=total+${i%100}`).join('\n')+'\nreturn total';
  const result=obfuscate({source,seed:'large'});assert.ok(result.stats.inputBytes>20000);assert.ok(result.stats.outputBytes>result.stats.inputBytes);
});
