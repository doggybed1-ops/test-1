import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {obfuscate} from '../engine/index.js';
import {executeDetailed} from '../tests/runtime.js';
import {fixtures} from '../tests/fixtures.js';
import {spawnSync} from 'node:child_process';
const report={date:new Date().toISOString(),runtimes:{lua51:'wasmoon-lua5.1 1.18.12 (PUC Lua 5.1 WASM)',lua53:'Fengari 0.1.5 (Lua 5.3)',luau:'luau-web 1.4.0 Asyncify (Luau WASM; protected-call probe enabled)'},comparisons:0,attemptedComparisons:0,skippedComparisons:0,fixtures:fixtures.length,profiles:['standard','advanced','maximum'],results:[],failures:[]};
const native=spawnSync(process.env.LUA54_BIN||'lua',['-v'],{encoding:'utf8',windowsHide:true});
const nativeVersion=(native.stdout||'')+(native.stderr||'');
if(!native.error&&/Lua 5\.4\./.test(nativeVersion))report.runtimes.lua54=nativeVersion.trim();
else report.notes=['Native Lua 5.4 not found; set LUA54_BIN to include it.'];
report.plannedComparisons=Object.keys(report.runtimes).length*report.fixtures*report.profiles.length;
for(const runtime of Object.keys(report.runtimes)) {
  for(const [name,source] of fixtures) {
    let original;
    try {
      const baseline=await executeDetailed(source,runtime);
      if(!baseline.succeeded) throw new Error(`Original fixture raised an error: ${baseline.result}`);
      original=baseline.result;
    } catch(error) {
      report.failures.push({runtime,fixture:name,stage:'original-execution',error:error.message});
      for(const profile of report.profiles) report.results.push({runtime,fixture:name,profile,passed:false,skipped:true,reason:'original-execution-failed'});
      report.skippedComparisons+=report.profiles.length;
      console.error(`BASELINE FAIL ${runtime} / ${name}: ${error.message.slice(0,200)}`);
      continue;
    }
    for(const profile of report.profiles) {
      let stage='compilation';report.attemptedComparisons++;
      try {
        const result=obfuscate({source,profile,dialect:runtime==='luau'?'luau':runtime,seed:`compat:${runtime}:${name}`});
        stage='protected-execution';const output=await executeDetailed(result.code,runtime);
        assert.equal(output.succeeded,true,'Protected fixture raised an error.');
        stage='comparison';assert.equal(output.result,original);
        report.comparisons++;report.results.push({runtime,fixture:name,profile,passed:true});
      }catch(error){report.failures.push({runtime,fixture:name,profile,stage,error:error.message});report.results.push({runtime,fixture:name,profile,passed:false,stage});console.error(`FAIL ${runtime} / ${profile} / ${name}: ${error.message.slice(0,200)}`);}
    }
  }
  console.log(`${runtime}: completed ${fixtures.length*3} comparisons`);
}
report.passed=report.failures.length===0&&report.comparisons===report.plannedComparisons;
await mkdir('reports',{recursive:true});await writeFile('reports/compatibility.json',JSON.stringify(report,null,2));
console.log(`${report.comparisons}/${report.plannedComparisons} passed, ${report.failures.length} failures, ${report.skippedComparisons} skipped. Report: reports/compatibility.json`);
if(!report.passed)process.exitCode=1;
