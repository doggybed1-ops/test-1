const crypto = require('node:crypto');
const MAX = 250000;
const keywords = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));
function tokenize(src){
  const tokens=[];let i=0;
  while(i<src.length){
    const start=i, ch=src[i], rest=src.slice(i);
    if(/\s/.test(ch)){while(i<src.length&&/\s/.test(src[i]))i++;tokens.push({type:'space',raw:src.slice(start,i)});continue;}
    if(rest.startsWith('--')){
      let m=rest.match(/^--\[(=*)\[/);
      if(m){let end=']'+m[1]+']',p=src.indexOf(end,i+m[0].length);i=p<0?src.length:p+end.length;}
      else {i=src.indexOf('\n',i);if(i<0)i=src.length;}
      tokens.push({type:'comment',raw:src.slice(start,i)});continue;
    }
    if(ch==='"'||ch==="'"){
      const quote=ch;i++;let closed=false;
      while(i<src.length){if(src[i]==='\\'){i+=2;continue;}if(src[i]===quote){i++;closed=true;break;}i++;}
      if(!closed)throw Error('Unterminated string literal');
      tokens.push({type:'string',raw:src.slice(start,i),quote});continue;
    }
    const long=rest.match(/^\[(=*)\[/);
    if(long){let end=']'+long[1]+']',p=src.indexOf(end,i+long[0].length);if(p<0)throw Error('Unterminated long string');i=p+end.length;tokens.push({type:'longstring',raw:src.slice(start,i)});continue;}
    const num=rest.match(/^(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
    if(num){i+=num[0].length;tokens.push({type:'number',raw:num[0]});continue;}
    const ident=rest.match(/^[a-zA-Z_][a-zA-Z_0-9]*/);
    if(ident){i+=ident[0].length;tokens.push({type:keywords.has(ident[0])?'keyword':'identifier',raw:ident[0]});continue;}
    let op=['...','..','==','~=','<=','>=','//','<<','>>','::'].find(x=>rest.startsWith(x));
    if(!op)op=ch;i+=op.length;tokens.push({type:'symbol',raw:op});
  }
  return tokens;
}
function decodeLuaQuoted(raw){
  let out=[];for(let i=1;i<raw.length-1;i++){
    let c=raw[i];if(c!=='\\'){out.push(c.codePointAt(0));continue;}
    c=raw[++i];if(c===undefined)throw Error('Invalid escape');
    const map={a:7,b:8,f:12,n:10,r:13,t:9,v:11,'\\':92,'"':34,"'":39};
    if(Object.hasOwn(map,c)){out.push(map[c]);continue;}
    if(c==='z'){while(/\s/.test(raw[i+1]||''))i++;continue;}
    if(c==='x'){const hex=raw.slice(i+1,i+3);if(!/^[0-9a-fA-F]{2}$/.test(hex))throw Error('Invalid hex escape');out.push(parseInt(hex,16));i+=2;continue;}
    if(/[0-9]/.test(c)){let digits=c;while(digits.length<3&&/[0-9]/.test(raw[i+1]||''))digits+=raw[++i];let n=Number(digits);if(n>255)throw Error('Invalid byte escape');out.push(n);continue;}
    if(c==='\n'){out.push(10);continue;}
    if(c==='\r'){if(raw[i+1]==='\n')i++;out.push(10);continue;}
    // Unknown escapes are rejected instead of risking changed behavior.
    throw Error('Unsupported escape sequence: \\'+c);
  }
  return out;
}
function encodeString(raw){
  const bytes=decodeLuaQuoted(raw);
  // string.char is ASCII/byte oriented; preserve Unicode source literals without rewriting.
  if(bytes.some(x=>x>127))return raw;
  if(!bytes.length)return '""';
  const parts=[];for(let i=0;i<bytes.length;i+=75)parts.push('string.char('+bytes.slice(i,i+75).join(',')+')');
  return '('+parts.join('..')+')';
}
function randomName(){return '_'+crypto.randomBytes(9).toString('hex');}
function obfuscate(source, options={}){
  const tokens=tokenize(source);
  const rewriteStrings=options.strings!==false;
  const rewriteNumbers=options.numbers!==false;
  let transformed=0;
  const out=[];
  // Token-safe spacing: use spaces between lexical units to avoid accidental merging.
  for(const token of tokens){
    if(token.type==='space'||token.type==='comment')continue;
    let raw=token.raw;
    if(token.type==='string'&&rewriteStrings){raw=encodeString(raw);if(raw!==token.raw)transformed++;}
    if(token.type==='number'&&rewriteNumbers&&/^\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))){
      const n=Number(raw);if(n<=0xffffffff){raw='0x'+n.toString(16);transformed++;}
    }
    out.push(raw);
  }
  const code='-- Protected with VeilForge | Lua 5.1+ compatible transformations\n'+out.join(' ')+ '\n';
  return {code,stats:{inputBytes:Buffer.byteLength(source),outputBytes:Buffer.byteLength(code),transforms:transformed,tokens:out.length}};
}
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return {statusCode:405,headers:{Allow:'POST'},body:'Method Not Allowed'};
  try{
    if((event.body||'').length>MAX*2)return {statusCode:413,body:JSON.stringify({error:'Source is too large'})};
    const data=JSON.parse(event.body||'{}');
    if(typeof data.source!=='string'||!data.source.trim())return {statusCode:400,body:JSON.stringify({error:'Paste Lua source code first.'})};
    if(Buffer.byteLength(data.source)>MAX)return {statusCode:413,body:JSON.stringify({error:'Maximum input size is 250 KB.'})};
    const result=obfuscate(data.source,data.options||{});
    return {statusCode:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(result)};
  }catch(e){return {statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:e.message||'Invalid input'})};}
};
exports._internal={tokenize,obfuscate};
