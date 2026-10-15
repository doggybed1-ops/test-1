import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Random } from './random.js';
import { parse, walk, annotateParentheses, validateSupported, validateSyntax, CompilerError, DIALECTS } from './parse.js';
import { transformSource } from './source.js';
import { virtualize } from './vm.js';

export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const OPTION_NAMES = ['rename','stringProtection','constantProtection','controlFlow','opaquePredicates','lazyStrings'];
export const PROFILES = {
  standard: {rename:true,stringProtection:true,constantProtection:true,controlFlow:false,opaquePredicates:false,lazyStrings:true},
  advanced: {rename:true,stringProtection:true,constantProtection:true,controlFlow:true,opaquePredicates:true,lazyStrings:true},
  maximum: {rename:true,stringProtection:true,constantProtection:true,controlFlow:true,opaquePredicates:true,lazyStrings:true},
};
export function capabilities() {
  return {version:'0.1.0',maxSourceBytes:MAX_SOURCE_BYTES,maxOutputBytes:MAX_OUTPUT_BYTES,profiles:PROFILES,dialects:DIALECTS,
    features:{ast:true,sourceRenaming:true,byteStringProtection:true,constantPooling:true,eligibleBlockFlattening:true,customVM:true,closures:true,varargs:true},
    limits:['No Luau-specific syntax or Lua 5.2–5.4 extensions','No debug/stack/environment introspection','VM changes stack traces, function identity details, and performance','No original-source execution during requests','No commercial protection parity claim']};
}
export function obfuscate({source,profile='maximum',dialect='lua51',options={},seed}={}) {
  const started = performance.now();
  if (typeof source !== 'string' || !source.trim()) throw new CompilerError('EMPTY_SOURCE','Enter a Lua program to compile.');
  const inputBytes=Buffer.byteLength(source,'utf8');
  if(inputBytes>MAX_SOURCE_BYTES) throw new CompilerError('SOURCE_TOO_LARGE','Source exceeds the 512 KiB limit.');
  if(typeof profile!=='string'||!Object.hasOwn(PROFILES,profile)) throw new CompilerError('INVALID_PROFILE','Select standard, advanced, or maximum protection.');
  if(options===null || typeof options!=='object' || Array.isArray(options)) throw new CompilerError('INVALID_OPTIONS','Protection options must be an object.');
  for(const [key,value] of Object.entries(options)) if(!OPTION_NAMES.includes(key)||typeof value!=='boolean') throw new CompilerError('INVALID_OPTIONS',`Unknown or invalid option: ${key}.`);
  const resolved={...PROFILES[profile],...options};
  if(profile==='standard' && (resolved.controlFlow||resolved.opaquePredicates)) throw new CompilerError('INVALID_OPTIONS','Control-flow transforms require Advanced or Maximum.');
  if(profile==='maximum' && ['rename','stringProtection','constantProtection','controlFlow'].some(key=>!resolved[key])) throw new CompilerError('INVALID_OPTIONS','Maximum requires VM identifiers, strings, constants, and control-flow protection.');
  const byteSource=Buffer.from(source,'utf8').toString('latin1');
  const ast=parse(byteSource,dialect), nodeCount=validateSupported(ast,profile,dialect);
  annotateParentheses(ast,byteSource,dialect);
  const names=[];walk(ast,node=>{if(node.type==='Identifier')names.push(node.name);});
  const random=new Random(seed,names);
  let result;
  try { result=profile==='maximum' ? virtualize(ast,{random,options:resolved,dialect}) : transformSource(ast,byteSource,{random,options:resolved,profile,dialect}); }
  catch(error) {
    if(error.code) { if(error.loc&&!error.line){error.line=error.loc.start?.line;error.column=error.loc.start?.column;} throw error; }
    throw new CompilerError('TRANSFORMATION_FAILED',`Compilation failed: ${error.message}`);
  }
  const code=Buffer.from(result.code,'latin1').toString('utf8');
  if(Buffer.byteLength(code)>MAX_OUTPUT_BYTES) throw new CompilerError('OUTPUT_TOO_LARGE','Protected output exceeds the 16 MiB limit.');
  try { validateSyntax(Buffer.from(code,'utf8').toString('latin1'),dialect); }
  catch(error) { throw new CompilerError('OUTPUT_VALIDATION_FAILED',`Generated output failed syntax validation: ${error.message}`); }
  if(code===source || !result.passes?.length) throw new CompilerError('NO_TRANSFORMATIONS','No enabled protection pass could transform this source.');
  return {code,buildId:randomUUID(),profile,dialect,passes:result.passes,
    stats:{...result.stats,inputBytes,outputBytes:Buffer.byteLength(code,'utf8'),astNodes:nodeCount,durationMs:Math.round((performance.now()-started)*100)/100},
    compatibility:{dialect,scope:DIALECTS[dialect].scope,syntaxValidated:true,executionValidated:false},
    warnings:[...(result.warnings||[]),...(dialect!=='lua51'?[DIALECTS[dialect].scope]:[]),...(profile==='maximum'?['Virtualization changes stack traces and adds execution overhead. Stack/environment introspection is unsupported.']:[])]};
}
