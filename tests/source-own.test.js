import test from 'node:test';
import assert from 'node:assert/strict';
import { obfuscate } from '../engine/index.js';
import { parse } from '../engine/parse.js';
import { execute } from './runtime.js';

const edgeCases = [
  ['shorthand string calls', `local function f(x) return '['..x..']' end local t={} function t:g(x)return f(x) end print(f'one',f[[two]],t:g'three') return f'four'`],
  ['recursive local and shadowed method self', `local function f(n) if n<2 then return n end return f(n-1)+f(n-2) end local t={x=8} function t:g(self) return function()return self end end return f(8),t:g(33)()`],
  ['initializer closures resolve earlier locals', `local x=7 local f=function()return x end local x=function()return x end local a,b=1,2 local a,b=b,a return f(),x(),a,b`],
  ['repeat condition closes over body binding', `local x=10 local n=0 repeat local x=n n=n+1 until (function()return x end)()==3 return x,n`],
  ['branch locals plus outer breaks', `local n=0 while true do n=n+1 if n>3 then local k=n if k>=4 then break end end n=n+1 end return n`],
  ['nested lowered loops and breaks', `local n=0 local x=0 while n<6 do n=n+1 while true do x=x+1 if x%2==0 then break end end if n==5 then break end end return n,x`],
  ['retained numeric loops with child regions', `local sum=0 for i=1,9 do if i==7 then break end sum=sum+i sum=sum+1 end local j=3 while j>0 do sum=sum+j j=j-1 end repeat local k=sum-1 sum=k until k<20 return sum`],
  ['dot access parentheses and declaration paths', `local a={b={x=4}} function a.b.f(v)return v+1 end local x=(a.b).x local y=(a.b).f(x) return y,a.b.f(8)`],
  ['identifier keys retain evaluation order', `local n=0 local function f()n=n+1 return n end local t={a=f(),[f()]=f(),f()} return n,t.a,t[1],t[2]`],
  ['signed zero and float spellings', `return 1/(-0.0),0.0000000000000001,1.0,1e1,0x1f,1.7976931348623157e308,9007199254740991`],
  ['empty and all byte strings', `local s='\\000\\001\\031\\127\\128\\254\\255' return '',#s,string.byte(s,1,#s),s`],
  ['leading directives and unicode comments', `--!strict\n-- source header 🌙\nlocal name='héllo 🌙' return name`],
  ['literal statement boundaries before parenthesized calls', `local n=1\n(function() n=n+1 end)() local text='x'\n(function() text=text..'y' end)() return n,text`],
  ['abutting parsed call statements', `local n=0 local function a()n=n+1 end local function b()n=n+2 end a()b() return n`],
  ['existing separators and semicolons inside comments', `local n=1;\n(function() n=n+1 end)() local s='x' -- ; this is not a separator\n(function()s=s..'y' end)() return n,s`],
];

for (const [name, source] of edgeCases) {
  test(`source differential: ${name}`, { timeout: 30000 }, async () => {
    const baseline = await execute(source);
    for (const profile of ['standard', 'advanced']) {
      for (const seed of [`edge:${name}:a`, `edge:${name}:b`]) {
        const result = obfuscate({ source, profile, seed });
        assert.equal(await execute(result.code), baseline, `${profile} differs: ${name}`);
      }
    }
  });
}

test('source options independently enable actual passes', { timeout: 30000 }, async () => {
  const source = `local value=3 local text='a private phrase' value=value+1 print(text,value) value=value*2 return value,text`;
  const baseline = await execute(source);
  const disabled = { rename: false, stringProtection: false, constantProtection: false, controlFlow: false, opaquePredicates: false, lazyStrings: true };
  for (const option of ['rename', 'stringProtection', 'constantProtection', 'controlFlow']) {
    const result = obfuscate({ source, profile: 'advanced', options: { ...disabled, [option]: true }, seed: option });
    assert.equal(await execute(result.code), baseline, `${option} changes behavior`);
    assert.equal(result.stats.identifiersRenamed > 0, option === 'rename');
    assert.equal(result.stats.stringsProtected > 0, option === 'stringProtection');
    assert.equal(result.stats.numbersProtected > 0, option === 'constantProtection');
    assert.equal(result.stats.flattenedBlocks > 0, option === 'controlFlow');
  }
});

test('eager and lazy decoder modes agree and remove plaintext', { timeout: 30000 }, async () => {
  const source = `local text='UNIQUE_SOURCE_ONLY_STRING_372197' return text,text..'!'`;
  const baseline = await execute(source);
  for (const lazyStrings of [false, true]) {
    const result = obfuscate({ source, profile: 'advanced', options: { lazyStrings }, seed: `lazy:${lazyStrings}` });
    assert.ok(!result.code.includes('UNIQUE_SOURCE_ONLY_STRING_372197'));
    assert.ok(result.passes.includes(lazyStrings ? 'lazy-string-cache' : 'eager-string-cache'));
    assert.equal(await execute(result.code), baseline);
  }
});

test('source passes preserve headers and report ineligible regions honestly', () => {
  const source = `--!strict\n-- retained header\nlocal x='private' return x`;
  const result = obfuscate({ source, profile: 'advanced', seed: 'header' });
  assert.ok(result.code.startsWith('--!strict\n-- retained header\n'));
  assert.equal(result.stats.flattenedBlocks, 0);
  assert.ok(result.warnings.some(warning => warning.includes('No block was eligible')));
  assert.ok(!result.passes.includes('randomized-cfg-state-machines'));
});

test('Lua 5.3 integer and float token forms remain exact', { timeout: 30000 }, async () => {
  const source = `return math.type(1),math.type(1.0),math.type(1e1),math.type(0x1),math.type(2147483647),math.type(2147484000),2147484000,math.type(9223372036854775807),9223372036854775807,-9223372036854775808,1/(-0.0)`;
  const baseline = await execute(source, 'lua53');
  for (const profile of ['standard', 'advanced']) {
    const result = obfuscate({ source, profile, dialect: 'lua53', seed: 'integer-types' });
    parse(Buffer.from(result.code, 'utf8').toString('latin1'), 'lua53');
    assert.equal(await execute(result.code, 'lua53'), baseline);
  }
});

test('source helpers respect Lua active-local limits', { timeout: 30000 }, async () => {
  // The regression harness itself is vararg; Lua 5.1 compatibility builds can
  // allocate an implicit `arg` local, leaving 199 explicit declaration slots.
  const declarations = Array.from({ length: 199 }, (_, i) => `v${i}`).join(',');
  const source = `local ${declarations}=1 return v0,'near the local limit'`;
  const baseline = await execute(source);
  for (const profile of ['standard', 'advanced']) {
    const result = obfuscate({ source, profile, seed: `local-limit:${profile}` });
    assert.equal(result.stats.chunkWrapped, true);
    assert.equal(await execute(result.code), baseline);
    if (profile === 'advanced') {
      assert.equal(result.stats.controlFlowSkippedLocalLimit, true);
      assert.equal(result.stats.flattenedBlocks, 0);
    }
  }
  assert.throws(() => obfuscate({ source: `local ${declarations},v199 return ...,'value'`, profile: 'standard' }), { code: 'LOCAL_LIMIT' });
});

test('source statistics count retained CFG output rather than intermediate regions', () => {
  const source = `local n=0 do do n=n+1 n=n*2 end n=n+2 end n=n+3 return n`;
  const result = obfuscate({ source, profile: 'advanced', seed: 'retained-regions' });
  assert.equal(result.stats.flattenedBlocks, 1);
  assert.equal(result.stats.virtualStates, 6);
  assert.equal(result.stats.opaquePredicates, 1);
});
