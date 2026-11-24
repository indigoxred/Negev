import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchProwlarrTorrentBytes } from '../src/acquisition/prowlarr-torrent-bytes.mjs';
const proxy='http://prowlarr.internal:9696/3/download?apikey=syntheticKey&link=abc123&file=Example';
const config={baseUrl:'http://prowlarr.internal:9696/',apiKey:'syntheticKey',query:'Example',candidate:{guid:'release-1',indexerId:3,title:'Example 01',size:1000,proxyUrl:proxy},indexerIds:[3]};
for(const [label,status,headers,chunk,reason] of [
 ['provider rejection',503,{},null,'torrent_unavailable'],
 ['magnet redirect',301,{location:'magnet:?xt=urn:btih:abc'},null,'magnet_only'],
 ['wrong content type',200,{'content-type':'text/plain'},null,'torrent_unavailable'],
 ['declared overflow',200,{'content-type':'application/x-bittorrent','content-length':'8388609'},null,'torrent_too_large'],
 ['stream overflow',200,{'content-type':'application/x-bittorrent'},new Uint8Array(8388609),'torrent_too_large'],
])test(`torrent retrieval cancels ${label} without waiting for cancellation`,async()=>{
 let finish,cancelled=false,timer;
 const response=new Response(new ReadableStream({start(c){if(chunk)c.enqueue(chunk)},cancel(){cancelled=true;return new Promise(resolve=>finish=resolve)}}),{status,headers});
 const pending=fetchProwlarrTorrentBytes({...config,fetchImpl:async()=>response});
 let result;
 try{result=await Promise.race([pending,new Promise(resolve=>timer=setTimeout(()=>resolve('blocked'),150))])}
 finally{clearTimeout(timer);finish?.();if(result==='blocked')void response.body.cancel().catch(()=>{});}
 assert.notEqual(result,'blocked');assert.equal(cancelled,true);assert.deepEqual(result,{state:'held',reason});
});
