import {createHmac} from 'node:crypto';

export default async (request,context) => {
  const headers={'content-type':'application/json','cache-control':'no-store'};
  const error=(status,code,message)=>new Response(JSON.stringify({error:{code,message}}),{status,headers});
  const base=process.env.PROCESSOR_URL;
  if(!base||!process.env.PROCESSOR_TOKEN)return error(503,'PROCESSOR_NOT_CONFIGURED','Set PROCESSOR_URL and PROCESSOR_TOKEN in Netlify to connect the processing service.');
  const route=new URL(request.url).pathname;
  if(!['/api/obfuscate','/api/capabilities'].includes(route))return error(404,'NOT_FOUND','Endpoint not found.');
  if(request.method!==(route==='/api/obfuscate'?'POST':'GET'))return error(405,'METHOD_NOT_ALLOWED','Unsupported request method.');
  try {
    let body;
    if(request.method==='POST') {
      if(!String(request.headers.get('content-type')||'').startsWith('application/json'))return error(415,'CONTENT_TYPE','Send application/json.');
      const reader=request.body?.getReader();const chunks=[];let total=0;
      if(!reader)return error(400,'EMPTY_REQUEST','Request body is required.');
      for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>4*1024*1024){await reader.cancel();return error(413,'REQUEST_TOO_LARGE','Request exceeds the 4 MiB transport limit.');}chunks.push(Buffer.from(value));}
      body=Buffer.concat(chunks);
    }
    const upstream=await fetch(new URL(route,base),{method:request.method,headers:{'content-type':'application/json','authorization':`Bearer ${process.env.PROCESSOR_TOKEN}`,'x-veil-client':createHmac('sha256',process.env.PROCESSOR_TOKEN).update(context.ip||'unknown').digest('hex')},body,signal:AbortSignal.timeout(18000),redirect:'error'});
    const responseHeaders={...headers};const retry=upstream.headers.get('retry-after');if(retry)responseHeaders['retry-after']=retry;
    return new Response(upstream.body,{status:upstream.status,headers:responseHeaders});
  }catch{return error(502,'PROCESSOR_UNAVAILABLE','The processing service is unavailable or timed out.');}
};
export const config={path:'/api/*'};
