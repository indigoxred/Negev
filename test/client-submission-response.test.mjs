import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {submitStoppedCandidate} from '../src/acquisition/submit-stopped-candidate.mjs';
import {buildStoppedTorrentAddForm} from '../src/acquisition/qbittorrent-add-form.mjs';

function encode(value) {
  if(Buffer.isBuffer(value))return Buffer.concat([Buffer.from(`${value.length}:`),value]);
  if(typeof value==='string')return encode(Buffer.from(value));
  if(typeof value==='number')return Buffer.from(`i${value}e`);
  if(Array.isArray(value))return Buffer.concat([Buffer.from('l'),...value.map(encode),Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'),...Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).flatMap(([key,item])=>[encode(key),encode(item)]),Buffer.from('e')]);
}
const info={files:[{length:1000,path:['Example.mkv']},{length:20,path:['readme.nfo']}],name:'Release','piece length':16384,pieces:Buffer.alloc(20,97)};
const hash=createHash('sha1').update(encode(info)).digest('hex');
const savePath=`/Downloads/negev/${hash}`;
const candidate={indexerId:7,guid:'synthetic'};
const prepared={state:'prepared_stopped',expected:{hash,category:'negev',savePath},form:buildStoppedTorrentAddForm({torrentBytes:encode({info}),savePath,category:'negev'})};
const torrent={hash,category:'negev',save_path:savePath,state:'stoppedDL',progress:0,downloaded:0,amount_left:1020,auto_tmm:false,force_start:false};
const hostPath='/srv/negev/staging';
const mount=(Source,Destination,RW=true)=>({Type:'bind',Source,Destination,RW});
const options={candidate,prepared,hostPath,baseUrl:'http://qb/',sessionId:'syntheticSID',nowMs:201,attemptId:7,
 inspectMounts:async()=>({qbittorrent:[mount(hostPath,'/Downloads/negev')],shoko:[mount('/srv/library','/pure')],plex:[mount('/srv/library','/source-pure',false)]}),realpathImpl:async()=>hostPath};
for(const endpoint of ['add','filePrio'])for(const status of [200,302,403,503])for(const mode of ['normal','pending','reject','throw']){
 test(`submission ${endpoint} disposes unused ${status} with ${mode} cancellation`,async()=>{
  let cancels=0,adds=0,priorities=0,added=false,excluded=false;
  const receipt=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('unused'));},cancel(){cancels++;if(mode==='pending')return new Promise(()=>{});if(mode==='reject')return Promise.reject(Error('synthetic rejection'));}}),{status});
  if(mode==='throw')receipt.body.cancel=()=>{cancels++;throw Error('synthetic cancellation failure');};
  const ledger={bindPreparedTorrent:()=>({state:'prepared'}),beginDispatch:()=>({state:'dispatch_unknown',sendNow:true}),recordTorrent:()=>({state:'torrent_observed'})};
  let timer;
  try{
   const run=submitStoppedCandidate({...options,ledger,fetchImpl:async url=>{
    if(url.pathname.endsWith('/version'))return new Response('v5.3.0');
    if(url.pathname.endsWith('/add')){adds++;added=true;return endpoint==='add'?receipt:new Response('Ok.');}
    if(url.pathname.endsWith('/filePrio')){priorities++;excluded=true;return endpoint==='filePrio'?receipt:new Response('Ok.');}
    if(url.pathname.endsWith('/info'))return Response.json(added?[torrent]:[]);
    if(url.pathname.endsWith('/properties'))return Response.json({save_path:savePath,download_path:''});
    return Response.json([{index:0,name:'Example.mkv',size:1000,priority:1,progress:0},{index:1,name:'readme.nfo',size:20,priority:excluded?0:1,progress:0}]);
   }});
   const result=await Promise.race([run,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('response cleanup blocked submission')),500);})]);
   assert.equal(result.state,'stopped_observed',JSON.stringify(result));assert.equal(adds,1);assert.equal(priorities,1);assert.equal(cancels,1);assert.equal(receipt.body.locked,false);
   await new Promise(resolve=>setImmediate(resolve));
  }finally{clearTimeout(timer);}
 });
}
