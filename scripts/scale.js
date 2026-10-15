import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {CompilerPool} from '../server/pool.js';
import {executeDetailed} from '../tests/runtime.js';
const statements=10000;
const source='local total=0\n'+Array.from({length:statements},(_,i)=>`total=total+${i%100}`).join('\n')+'\nreturn total';
const pool=new CompilerPool({concurrency:1});
try {
  const compiled=await pool.run({source,profile:'maximum'});
  const original=await executeDetailed(source,'lua51',30000),protectedResult=await executeDetailed(compiled.code,'lua51',30000);
  assert.equal(original.succeeded,true);assert.equal(protectedResult.succeeded,true);assert.equal(protectedResult.result,original.result);
  const report={date:new Date().toISOString(),passed:true,statements,runtime:'Actual Lua 5.1 via WASM',worker:{oldGenerationMiB:192,youngGenerationMiB:32,deadlineMs:15000},stats:compiled.stats,equivalent:true,notes:['One synthetic large-program case, not a guarantee for all inputs at the source-size limit.','Data factories avoid Lua 5.1 per-function constant-table limits.','Complete output grammar validated without retaining completed data-table ASTs.']};
  await mkdir('reports',{recursive:true});await writeFile('reports/scalability.json',JSON.stringify(report,null,2));console.log(`Passed: ${compiled.stats.inputBytes} source bytes, ${compiled.stats.outputBytes} output bytes, ${compiled.stats.vmInstructions} instructions, ${compiled.stats.durationMs} ms compilation.`);
}finally{await pool.close();}
