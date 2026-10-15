import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {obfuscate} from '../engine/index.js';
import {executeDetailed} from '../tests/runtime.js';
const source=await readFile('examples/counter.lua','utf8');
const baseline=await executeDetailed(source);if(!baseline.succeeded)throw new Error('Example baseline failed.');
const report={date:new Date().toISOString(),example:'examples/counter.lua',results:[],interpretation:'Structural compiler evidence only. No competitor or resistance-to-reversal benchmark has been performed.'};
for(const profile of ['standard','advanced','maximum']) {
  const a=obfuscate({source,profile}),b=obfuscate({source,profile});
  const execution=await executeDetailed(a.code);
  const result={profile,passes:a.passes,stats:a.stats,randomized:a.code!==b.code,originalLiteralAbsent:!a.code.includes('PRIVATE_COUNTER_RESULT'),equivalentInLua51:execution.succeeded&&execution.result===baseline.result};
  if(!result.randomized||!result.originalLiteralAbsent||!result.equivalentInLua51)throw new Error(`Protection evidence failed: ${profile}`);
  await writeFile(`examples/counter.${profile}.lua`,a.code);report.results.push(result);
}
await mkdir('reports',{recursive:true});await writeFile('reports/protection-analysis.json',JSON.stringify(report,null,2));console.log('Verified example outputs and reports/protection-analysis.json');
