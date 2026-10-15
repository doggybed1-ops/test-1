import test from 'node:test';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import { parse, annotateParentheses } from '../engine/parse.js';
import { virtualize } from '../engine/vm.js';
import { Random } from '../engine/random.js';
import { execute as executeIsolated, executeDetailed } from './runtime.js';
import { obfuscate } from '../engine/index.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

function execute(source) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const log = [];
  lua.lua_pushjsfunction(L, state => {
    const values = [];
    for (let i = 1; i <= lua.lua_gettop(state); i++) {
      lauxlib.luaL_tolstring(state, i);
      values.push(to_jsstring(lua.lua_tostring(state, -1)));
      lua.lua_pop(state, 1);
    }
    log.push(values.join('\t'));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('print'));
  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  const error = status === lua.LUA_OK ? null : to_jsstring(lua.lua_tostring(L, -1));
  lua.lua_close(L);
  assert.equal(error, null, error ?? undefined);
  return log;
}

function compile(source, seed = 'vm-fixture', options = {}, dialect = 'lua51') {
  const ast = parse(source, dialect);
  annotateParentheses(ast, source, dialect);
  const result = virtualize(ast, { random: new Random(seed), options, dialect });
  parse(result.code, dialect);
  return result;
}

const fixtures = {
  'closures, shared upvalues, recursive local functions and shadowing': `
local function factory(x)
  local function recurse(n) if n==0 then return x end return recurse(n-1)+1 end
  return function(n) x=x+n;return recurse(3) end,function() return x end
end
local a,b=factory(10);local c,d=factory(100)
print(a(2),b(),c(5),d(),b())
local x=8;do local x=x+1;print(x) end;print(x)
local f={};for i=1,4 do f[i]=function()return i end end
print(f[1](),f[2](),f[3](),f[4]())
`,
  'nil holes, varargs, parenthesized calls and list adjustment': `
local function f(...) return ... end
local function show(...) print(select('#',...),...) end
show(f(1,nil,3,nil));show((f(1,2,3)))
local a,b,c,d=f(8,nil,9);show(a,b,c,d)
local t={7,f(2,nil,4,nil)};show(t[1],t[2],t[3],t[4],t[5])
local t2={f(1,2),x=3};show(t2[1],t2[2],t2.x)
local function outer(...)return function(...)return f(...) end end
show(outer(0)(nil,2,nil))
`,
  'assignment addresses, evaluation order and repeated targets': `
local i=1;local a={10,20};i,a[i]=i+1,30;print(i,a[1],a[2])
local x=0;x,x=1,2;print(x)
local z={};local n=0;local function key()n=n+1;return n end
z[key()],z[key()]=11,22;print(z[1],z[2],n)
local function swap()local a,b=1,2;a,b=b,a;return a,b end;print(swap())
`,
  'structured branches, break, numeric and generic loops, repeat scope': `
local sum=0;for i=5,1,-1 do if i==3 then sum=sum+20 else sum=sum+i end end
local i=0;while true do i=i+1;if i>5 then break end;if i%2==0 then sum=sum+i end end
repeat local x=i*2;i=i-1;sum=sum+x until x<4
local function iter(s,k)k=k+1;if k<=s then return k,k*2 end end
for k,v in iter,4,0 do sum=sum+k+v end
local t={};for k,v in ipairs({10,20,30})do t[k]=function()return k,v end end
print(sum,i,t[1](),t[2](),t[3]())
`,
  'metatables, indirect and method calls, table/string call syntax': `
local mt={__add=function(a,b)return a.x+b.x end,__index=function(t,k)return k..'!' end}
local a=setmetatable({x=4},mt);local b=setmetatable({x=7},mt);print(a+b,a.missing)
local t={x=5};function t:add(y,...)self.x=self.x+y;return self.x,... end
print(t:add(3,nil,10));local f=function(x)return type(x),x[1] end;print(f{9})
local g=function(x)return #x,x end;print(g'abc')
local call=setmetatable({n=8},{__call=function(self,x)return self.n*x end});print(call(3))
`,
  'short-circuit operators and native coercions': `
local n=0;local function f()n=n+1;return n end
print(false and f(),true or f(),nil or f(),true and f(),n)
print(not nil,not 0,-2^2,2^-2,7%3,2^3,'a' .. 2 .. 'b',#'xyz')
for i='1','3','1'do print(i)end
`,
  'coroutine suspension and re-entry across VM closures': `
local co=coroutine.create(function(n)local x=n;for i=1,3 do x=x+i;coroutine.yield(x)end;return x*2 end)
print(coroutine.resume(co,10));print(coroutine.resume(co));print(coroutine.resume(co));print(coroutine.resume(co));print(coroutine.status(co))
`,
};

for (const [label, source] of Object.entries(fixtures)) {
  test(`VM preserves ${label}`, () => {
    const expected = execute(source);
    for (let i = 0; i < 3; i++) assert.deepEqual(execute(compile(source, `${label}-${i}`).code), expected);
  });
}

test('VM randomized layout, encryption, metadata and cache modes are effective', () => {
  const source = 'local secret="distinctive-private-message";return secret,123.125';
  const a = compile(source, 'a');
  const b = compile(source, 'b');
  assert.notEqual(a.code, b.code);
  assert.equal(a.code.includes('distinctive-private-message'), false);
  assert.equal(a.code.includes('123.125'), false);
  assert.ok(a.stats.vmInstructions > 5);
  assert.ok(a.stats.encryptedConstants >= 2);
  assert.deepEqual(execute(compile('print("cache",1.25)', 'off', {lazyStrings:false}).code), ['cache\t1.25']);
});

test('VM rejects unsupported syntax and introspection with source locations', () => {
  assert.throws(() => compile('return getfenv()'), error => error.code === 'UNSUPPORTED_FEATURE' && error.line === 1);
});

test('VM preserves tail recursion without growing the native call stack', () => {
  const source = 'local function count(n,a) if n==0 then return a,nil end return count(n-1,a+1) end print(count(3000,0))';
  assert.deepEqual(execute(compile(source, 'tail').code), execute(source));
});

test('VM matches Lua and Luau assignment order and native numeric-for coercion', async () => {
  const sources = [
    'local a=0;local t={};a,a=1,2;t[1],t[1]=3,4;return a,t[1]',
    'local a={};for i="1","3","1" do a[#a+1]=tostring(i)end;return table.concat(a,",")',
  ];
  for (const runtime of ['lua51', 'lua53', 'luau']) for (const source of sources) {
    const output = compile(source, 'dialect:' + runtime, {}, runtime).code;
    assert.equal(await executeIsolated(output, runtime), await executeIsolated(source, runtime));
  }
});

test('VM reports unsupported Luau generalized iteration and preserves Lua callable iterators', async () => {
  assert.throws(() => compile('for k,v in {1,2}do print(k,v)end', 'static-iterator', {}, 'luau'),
    error => error.code === 'UNSUPPORTED_FEATURE' && /generalized iteration/.test(error.message));
  const dynamic = compile('local t={1,2};for k,v in t do print(k,v)end', 'dynamic-iterator', {}, 'luau');
  assert.equal(dynamic.stats.iteratorGuards, 1);
  const output = await executeDetailed(dynamic.code, 'luau');
  assert.equal(output.succeeded, false);
  assert.ok(output.result.includes(Buffer.from('unsupported Luau generalized iteration').toString('hex')));
  const callable = 'local t=setmetatable({},{__call=function(_,s,c)c=(c or 0)+1;if c<3 then return c,c*2 end end});local n=0;for k,v in t do n=n+k+v end;return n';
  for (const runtime of ['lua51', 'lua53']) {
    assert.equal(await executeIsolated(compile(callable, 'callable', {}, runtime).code, runtime), await executeIsolated(callable, runtime));
  }
});

test('VM data factories execute large programs within Lua 5.1 constant limits', {timeout:30000}, async () => {
  const source='local total=0\n'+Array.from({length:8000},(_,i)=>`total=total+${i%100}`).join('\n')+'\nreturn total';
  const result=obfuscate({source,profile:'maximum',seed:'large-native-constants'});
  assert.ok(result.stats.vmInstructions>70000);
  assert.ok(result.stats.vmDataFactories>50);
  assert.ok(result.passes.includes('chunked-instruction-data'));
  const original=await executeDetailed(source,'lua51',20000);
  const output=await executeDetailed(result.code,'lua51',20000);
  assert.equal(output.succeeded,true);
  assert.deepEqual(output,original);
});
