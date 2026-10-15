import {parentPort,workerData} from 'node:worker_threads';
const {source,runtime}=workerData;
// Test-only execution. This module is never imported by production compilation.
const harness=`
local __logs={}
local function __pack(...) return {n=select('#',...),...} end
local function __serialize(x,seen)
 local kind=type(x)
 if kind=='nil' then return 'nil' end
 if kind=='string' then local b={} for i=1,#x do b[i]=string.format('%02x',string.byte(x,i)) end return 's:'..table.concat(b) end
 if kind=='number' then if x~=x then return 'n:nan' end if x==0 then return 'n:0:'..tostring(1/x) end return 'n:'..tostring(x) end
 if kind=='boolean' then return 'b:'..tostring(x) end
 if kind~='table' then return kind end
 seen=seen or {} if seen[x] then return '<cycle>' end seen[x]=true
 local parts={} for k,v in pairs(x) do parts[#parts+1]=__serialize(k,seen)..'='..__serialize(v,seen) end table.sort(parts) seen[x]=nil
 return '{'..table.concat(parts,',')..'}'
end
print=function(...) local a=__pack(...) local b={} for i=1,a.n do b[i]=__serialize(a[i]) end __logs[#__logs+1]=table.concat(b,';') end
io=nil os=nil package=nil require=nil dofile=nil loadfile=nil debug=nil
local function __subject(...)
${source}
end
local result=__pack(pcall(__subject,7,nil,'argument'))
return (result[1] and '1' or '0')..table.concat(__logs,'\\n')..'|'..__serialize(result)
`;

async function loadLuauAsyncify() {
  // luau-web 1.4.0's JSPI build lets errors escape Luau pcall on Node 24.
  // Its bundled Asyncify build catches them correctly. Select that build only
  // while importing the package in this disposable test worker, then restore
  // the host capability. No dependency files or production code are patched.
  const descriptor=Object.getOwnPropertyDescriptor(WebAssembly,'Suspending');
  if ('Suspending' in WebAssembly && !descriptor?.configurable) throw new Error('Cannot select the protected-call-compatible Luau Asyncify test runtime.');
  try {
    if(descriptor) delete WebAssembly.Suspending;
    return await import('luau-web');
  } finally {
    if(descriptor) Object.defineProperty(WebAssembly,'Suspending',descriptor);
  }
}

try {
  let result;
  if(runtime==='lua51') {
    const {Lua}=await import('wasmoon-lua5.1');const state=await Lua.create();
    try { result=await state.doString(harness); } finally {state.global.close();}
  } else if(runtime==='luau') {
    const {LuauState}=await loadLuauAsyncify();const state=await LuauState.createAsync();
    try {
      const probe=await state.loadstring('local ok,msg=pcall(function()error("protected-call-probe",0)end);return not ok and msg=="protected-call-probe"','runtime-probe',true)();
      if(!Array.isArray(probe)||probe[0]!==true) throw new Error('Luau protected-call runtime probe failed.');
      const returned=await state.loadstring(harness,'fixture',true)();result=Array.isArray(returned)?returned[0]:returned;
    } finally {state.destroy();}
  } else if(runtime==='lua53') {
    const {lua,lauxlib,lualib,to_luastring,to_jsstring}=await import('fengari');
    const state=lauxlib.luaL_newstate();lualib.luaL_openlibs(state);
    try { const status=lauxlib.luaL_dostring(state,to_luastring(harness));if(status!==lua.LUA_OK)throw new Error(to_jsstring(lua.lua_tostring(state,-1)));result=to_jsstring(lua.lua_tostring(state,-1)); } finally {lua.lua_close(state);}
  } else if(runtime==='lua54') {
    const {spawnSync}=await import('node:child_process');
    const script='local __write=io.write; local __result=(function()\n'+harness+'\nend)(); __write(__result)';
    const execution=spawnSync(process.env.LUA54_BIN||'lua',['-'],{input:script,encoding:'utf8',timeout:8000,maxBuffer:8*1024*1024,windowsHide:true});
    if(execution.error)throw execution.error;if(execution.status!==0)throw new Error(execution.stderr);result=execution.stdout;
  } else throw new Error(`Unknown test runtime ${runtime}`);
  if(typeof result!=='string'||!['0','1'].includes(result[0])) throw new Error('Test runtime returned an invalid harness result.');
  parentPort.postMessage({result:result.slice(1),succeeded:result[0]==='1'});
} catch(error) {parentPort.postMessage({error:error.message});}
