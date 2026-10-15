import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {capabilities} from '../engine/index.js';
import {CompilerPool} from './pool.js';

const BODY_LIMIT=4*1024*1024;
export function createApp({pool=new CompilerPool(),token=process.env.API_TOKEN||'',rateLimit=Number(process.env.RATE_LIMIT_PER_MINUTE)||20,logger=console}={}) {
  const buckets=new Map();
  const cleanup=setInterval(()=>{const now=Date.now();for(const [key,bucket] of buckets)if(now-bucket.start>60000)buckets.delete(key);},60000);cleanup.unref();
  const allowed=(process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID();
    const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId};
    const origin=req.headers.origin;
    if(origin&&allowed.includes(origin)){headers['access-control-allow-origin']=origin;headers.vary='Origin';}
    const send=(status,data)=>{if(!res.destroyed){let body=JSON.stringify(data);if(Buffer.byteLength(body)>18*1024*1024){status=422;body=JSON.stringify({error:{code:'RESPONSE_TOO_LARGE',message:'Serialized response exceeds the 18 MiB transport limit.'},requestId});}res.writeHead(status,headers);res.end(body);}};
    const fail=(status,code,message)=>send(status,{error:{code,message},requestId});
    if(req.method==='OPTIONS') { if(!origin||!allowed.includes(origin))return fail(403,'ORIGIN_DENIED','This browser origin is not enabled.');headers['access-control-allow-methods']='POST, GET, OPTIONS';headers['access-control-allow-headers']='Content-Type';res.writeHead(204,headers);return res.end(); }
    const route=(req.url||'').split('?')[0];
    if(route==='/health'&&req.method==='GET')return send(200,{status:'ok',version:'0.1.0'});
    if(route==='/api/capabilities'&&req.method==='GET')return send(200,capabilities());
    if(route!=='/api/obfuscate')return fail(404,'NOT_FOUND','Endpoint not found.');
    if(req.method!=='POST')return fail(405,'METHOD_NOT_ALLOWED','Use POST to compile Lua.');
    if(token) {
      const expected=Buffer.from(`Bearer ${token}`),received=Buffer.from(req.headers.authorization||'');
      if(received.length!==expected.length||!timingSafeEqual(received,expected))return fail(401,'UNAUTHORIZED','A valid processing token is required.');
    }
    const identity=token&&/^[a-f0-9]{64}$/.test(req.headers['x-veil-client']||'')?req.headers['x-veil-client']:req.socket.remoteAddress;
    const now=Date.now();let bucket=buckets.get(identity);
    if(!bucket||now-bucket.start>=60000){if(buckets.size>=10000)return fail(503,'SERVICE_BUSY','Rate-limit capacity reached.');bucket={start:now,count:0};buckets.set(identity,bucket);}
    if(++bucket.count>rateLimit){headers['retry-after']=String(Math.ceil((60000-(now-bucket.start))/1000));return fail(429,'RATE_LIMITED','Compilation rate limit reached. Try again in one minute.');}
    if(!String(req.headers['content-type']||'').startsWith('application/json'))return fail(415,'CONTENT_TYPE','Send application/json.');
    if(Number(req.headers['content-length'])>BODY_LIMIT)return fail(413,'REQUEST_TOO_LARGE','Request exceeds the 4 MiB transport limit.');
    let size=0,chunks=[];
    try {
      for await(const chunk of req){size+=chunk.length;if(size>BODY_LIMIT){fail(413,'REQUEST_TOO_LARGE','Request exceeds the transport limit.');return;}chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail(400,'INVALID_JSON','Request contains invalid JSON.');}finally{chunks=[];}
      if(!body||typeof body!=='object'||Array.isArray(body))return fail(400,'INVALID_REQUEST','Send a compilation request object.');
      if(Object.keys(body).some(key=>!['source','profile','dialect','options'].includes(key)))return fail(400,'INVALID_REQUEST','Request contains an unknown field.');
      const controller=new AbortController();
      const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
      let result;
      try{result=await pool.run(body,{signal:controller.signal});}finally{body=null;res.removeListener('close',cancel);}
      send(200,result);
      logger.info?.(JSON.stringify({event:'compile',requestId,status:200,profile:result.profile,inputBytes:result.stats.inputBytes,outputBytes:result.stats.outputBytes,durationMs:result.stats.durationMs}));
    }catch(error) {
      const busy=['SERVICE_BUSY','SERVICE_CLOSED'].includes(error.code),timeout=error.code==='COMPILATION_TIMEOUT';
      const status=busy?503:timeout?408:['WORKER_FAILED'].includes(error.code)?500:422;
      send(status,{error:{code:error.code||'COMPILATION_FAILED',message:error.message,line:error.line,column:error.column},requestId});
      logger.error?.(JSON.stringify({event:'compile_error',requestId,status,code:error.code||'COMPILATION_FAILED'}));
    }
  });
  server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  server.once('close',()=>{clearInterval(cleanup);pool.close();});
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.env.NODE_ENV==='production'&&!process.env.API_TOKEN)throw new Error('API_TOKEN is required in production.');
  const server=createApp();
  const port=Number(process.env.PORT)||8787,host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>console.log(`VEIL processing service http://${host}:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
