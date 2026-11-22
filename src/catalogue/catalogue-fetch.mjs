import { readBoundedText } from '../http/bounded-response.mjs';

const abortError=()=>new DOMException('Catalogue read aborted','AbortError');
// Only fixed public metadata routes participate. Never cache credentials,
// acquisition file evidence, private providers, artwork or arbitrary requests.
function route(input,options){
 let u;try{u=new URL(input);}catch{return null;}
 if(u.username||u.password||u.search||u.hash)return null;
 const headers=new Headers(options.headers);
 if([...headers.keys()].some(k=>!['accept','content-type'].includes(k)))return null;
 const method=(options.method??'GET').toUpperCase();
 if(u.origin==='https://graphql.anilist.co'&&u.pathname==='/'&&method==='POST'&&typeof options.body==='string'&&options.body.length<=20000)return {provider:u.origin,max:100000,key:method+' '+u.href+' '+options.body};
 if(u.origin!=='https://animap.id'||method!=='GET'||options.body!=null)return null;
 const p=u.pathname;
 const max=/^\/api\/anidb\/[1-9]\d*\/raw$/.test(p)?4000000:
  p==='/api/anidb/groups'?8000000:p==='/api/anidb/schedule'?512000:
  /^\/api\/(?:anidb\/[1-9]\d*|v1\/map\/anidb\/[1-9]\d*|mal\/[1-9]\d*\/raw)$/.test(p)?128000:null;
 if(max===null&&p!=='/api/v1/map')return null;
 return {provider:u.origin,max,key:method+' '+u.href};
}
export function createCatalogueFetch({fetchImpl=fetch,now=Date.now,concurrency=4,maxPending=20,
 cacheMs=60000,failureMs=10000,maxEntries=200,maxCacheBytes=16000000,timeoutMs=10000}={}){
 if(typeof fetchImpl!=='function'||typeof now!=='function'||
  ![concurrency,maxPending,cacheMs,failureMs,maxEntries,maxCacheBytes,timeoutMs].every(n=>Number.isSafeInteger(n)&&n>0)||
  concurrency>8||maxPending>100||cacheMs>300000||failureMs>60000||maxEntries>1000||maxCacheBytes>32000000||timeoutMs>30000)throw TypeError('Invalid catalogue fetch limits');
 const pending=new Map(),cache=new Map(),cooldowns=new Map(),queue=[];let active=0,bytes=0;
 const drop=key=>{const old=cache.get(key);if(old)bytes-=old.size;cache.delete(key);};
 const remember=(key,value)=>{drop(key);const size=value.text?Buffer.byteLength(value.text):0;if(size>maxCacheBytes)return;cache.set(key,{...value,size});bytes+=size;while(cache.size>maxEntries||bytes>maxCacheBytes)drop(cache.keys().next().value);};
 const response=value=>{if(value.error)throw Error('Catalogue provider unavailable');return new Response(value.text??null,{status:value.status,headers:value.headers});};
 const cooldown=provider=>{const saved=cooldowns.get(provider);return saved&&saved.until>now()?saved:null;};
 const throttled=value=>({status:value.status,headers:{'Retry-After':String(Math.max(1,Math.ceil((value.until-now())/1000)))}});
 const observe=(provider,r)=>{
  if(r.status!==429&&r.status!==503)return;
  const raw=r.headers?.get?.('retry-after');let until;
  if(raw&&/^\d+$/.test(raw.trim())&&Number.isSafeInteger(Number(raw)))until=now()+Number(raw)*1000;
  else if(raw&&Number.isFinite(Date.parse(raw)))until=Date.parse(raw);
  if(!Number.isSafeInteger(until)||until<=now())until=now()+(r.status===429?60000:30000);
  // A bad far-future response cannot grow the clock beyond Date's range.
  until=Math.min(until,8640000000000000);
  if(!cooldown(provider)||cooldowns.get(provider).until<until)cooldowns.set(provider,{until,status:r.status});
 };
 const consume=async job=>{
  const hold=cooldown(job.route.provider);if(hold)return throttled(hold);
  try{
   const r=await fetchImpl(job.input,{...job.options,signal:AbortSignal.timeout(timeoutMs)});observe(job.route.provider,r);
   const headers={};for(const name of ['content-type','retry-after']){const value=r.headers?.get?.(name);if(value)headers[name]=value;}
   if(r.status!==200){await r.body?.cancel().catch(()=>{});const value={status:r.status,headers,expires:now()+failureMs};remember(job.route.key,value);return value;}
   const text=await readBoundedText(r,job.route.max);JSON.parse(text);
   const value={status:200,headers,text,expires:now()+cacheMs};remember(job.route.key,value);return value;
  }catch{const value={error:true,expires:now()+failureMs};remember(job.route.key,value);return value;}
 };
 const pump=()=>{while(active<concurrency&&queue.length){const job=queue.shift();
  if(!job.waiters){pending.delete(job.route.key);job.reject(abortError());continue;}
  active++;void consume(job).then(job.resolve,job.reject).finally(()=>{active--;pending.delete(job.route.key);pump();});
 }};
 const subscribe=(job,signal)=>new Promise((resolve,reject)=>{
  job.waiters++;let finished=false;const finish=(fn,value)=>{if(finished)return;finished=true;job.waiters--;signal?.removeEventListener('abort',aborted);fn(value);};
  const aborted=()=>finish(reject,abortError());signal?.addEventListener('abort',aborted,{once:true});
  if(signal?.aborted)aborted();job.promise.then(v=>finish(resolve,v),e=>finish(reject,e));
 });
 return async(input,options={})=>{
  const target=route(input,options);if(!target)return fetchImpl(input,options);
  if(options.signal?.aborted)throw abortError();
  const hit=cache.get(target.key);if(hit&&hit.expires>now())return response(hit);if(hit)drop(target.key);
  const hold=cooldown(target.provider);if(hold)return response(throttled(hold));
  // The 60MB map retains its existing streaming parser/single-flight owner;
  // it shares origin cooldowns but is never buffered/cached in this small gate.
  if(target.max===null){const r=await fetchImpl(input,options);observe(target.provider,r);return r;}
  let job=pending.get(target.key);
  if(!job){if(queue.length>=maxPending)return new Response(null,{status:503,headers:{'Retry-After':'1'}});
   job={input,options,route:target,waiters:0};job.promise=new Promise((resolve,reject)=>{job.resolve=resolve;job.reject=reject;});pending.set(target.key,job);queue.push(job);
  }
  const waiting=subscribe(job,options.signal);queueMicrotask(pump);return response(await waiting);
 };
}
