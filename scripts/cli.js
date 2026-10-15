import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {obfuscate} from '../engine/index.js';
const args=process.argv.slice(2),flags={},paths=[];
for(let i=0;i<args.length;i++){if(args[i].startsWith('--')){const key=args[i].slice(2);if(!['profile','dialect','seed'].includes(key)||!args[i+1])throw new Error(`Invalid option ${args[i]}`);flags[key]=args[++i];}else paths.push(args[i]);}
if(paths.length!==2){console.error('Usage: npm run obfuscate -- input.lua protected.lua [--profile maximum] [--dialect lua51] [--seed test-only]');process.exitCode=1;}
else {
  try {
    if(resolve(paths[0])===resolve(paths[1]))throw new Error('Input and output must use different paths.');
    const result=obfuscate({source:await readFile(paths[0],'utf8'),...flags});
    await writeFile(paths[1],result.code,{flag:'wx'});
    console.log(JSON.stringify({buildId:result.buildId,passes:result.passes,stats:result.stats,warnings:result.warnings},null,2));
  }catch(error){console.error(`${error.code||'ERROR'}: ${error.message}`);process.exitCode=1;}
}
