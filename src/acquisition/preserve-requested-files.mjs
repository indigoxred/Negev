import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
const held=reason=>({state:'held',reason});
const same=(s,f)=>s?.isFile()&&!s.isSymbolicLink()&&s.size===BigInt(f.size)&&String(s.dev)===f.dev&&String(s.ino)===f.ino&&String(s.mtimeNs)===f.mtimeNs;
const stat=async p=>{try{return await lstat(p,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const sidecarMatches=(video,subtitle)=>path.posix.dirname(video.name)===path.posix.dirname(subtitle.name)&&
  path.posix.basename(subtitle.name).startsWith(path.posix.parse(video.name).name+'.');
async function sync(dir){if(process.platform==='win32')return;const h=await open(dir,constants.O_RDONLY|(constants.O_DIRECTORY??0));try{await h.sync();}finally{await h.close();}}
async function safePath(root,name,create=false){
 const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..')||/[\\\0\r\n]/.test(name)||path.posix.isAbsolute(name))throw Error('unsafe path');
 let current=root;for(const part of [null,...parts.slice(0,-1)]){
  if(part!==null)current=path.join(current,part);let s=await stat(current);
  if(!s&&create){await mkdir(current);await sync(path.dirname(current));s=await stat(current);}
  if(!s&&!create)return path.join(root,...parts);
  if(!s?.isDirectory()||s.isSymbolicLink())throw Error('unsafe directory');
 }return path.join(root,...parts);
}
async function validSubset(root,files){
 const expected=new Map(files.map(f=>[f.name,f])),dirs=new Set();for(const f of files){const p=f.name.split('/');for(let i=1;i<p.length;i++)dirs.add(p.slice(0,i).join('/'));}
 let count=0;const walk=async(dir,prefix='',depth=0)=>{if(depth>32)return false;for(const entry of await readdir(dir,{withFileTypes:true})){
  if(++count>200)return false;const name=prefix?prefix+'/'+entry.name:entry.name,s=await stat(path.join(dir,entry.name));if(!s||s.isSymbolicLink())return false;
  if(s.isDirectory()){if(!dirs.has(name)||!await walk(path.join(dir,entry.name),name,depth+1))return false;}
  else if(!expected.has(name)||!same(s,expected.get(name)))return false;
 }return true;};return walk(root);
}
// Mixed trees may already have been partially consumed by Shoko. Preserve only
// the requested video and unambiguous same-stem subtitles, leaving bonus paths
// untouched. The existing preservation intent plus exact inode evidence resolves
// a crash after any rename. Sidecars move first, the main video last.
export async function preserveRequestedFiles({manifest,source,destination,fileId,recheck,renameFile}){
 const videos=manifest.files.filter(f=>Array.isArray(f.episodeIds));const main=videos.filter(f=>f.scope!=='bonus');
 if(main.length!==1)return held('recovery_ineligible');
 const files=manifest.files.filter(f=>f===main[0]||torrentFileKind(f.name)==='subtitle'&&sidecarMatches(main[0],f)&&!videos.some(v=>v.scope==='bonus'&&sidecarMatches(v,f)))
  .sort((a,b)=>Number(Array.isArray(a.episodeIds))-Number(Array.isArray(b.episodeIds))||a.name.localeCompare(b.name));
 if(files.some(f=>!Number.isSafeInteger(f.size)||f.size<1||![f.dev,f.ino,f.mtimeNs].every(v=>typeof v==='string'&&/^\d+$/.test(v))))return held('published_tree_changed');
 try{
  const dest=await stat(destination);if(dest&&(!dest.isDirectory()||dest.isSymbolicLink()||!await validSubset(destination,files)))return held('recovery_tree_changed');
  const pending=[];
  for(const f of files){
   const from=await safePath(source,f.name);
   // A missing source root is valid only for an already completed rename set.
   const existing=dest?await safePath(destination,f.name):path.join(destination,...f.name.split('/'));
   const [a,b]=await Promise.all([stat(from),stat(existing)]);
   if(a&&b)return held('duplicate_recovery_file');if(b){if(!same(b,f))return held('recovery_tree_changed');continue;}
   if(!same(a,f))return held('published_tree_changed');pending.push({f,from});
  }
  if(!pending.length)return {state:'preserved',destination};
  const observed=await recheck();if(observed?.state!=='unrecognized_confirmed'||Number.isSafeInteger(fileId)&&observed.fileId!==fileId)return held('recognition_state_changed');
  for(const {f,from}of pending){
   const to=await safePath(destination,f.name,true);if(await stat(to)||!same(await stat(from),f))return held('preservation_state_changed');
   if(Array.isArray(f.episodeIds)){const latest=await recheck();if(latest?.state!=='unrecognized_confirmed'||Number.isSafeInteger(fileId)&&latest.fileId!==fileId)return held('recognition_state_changed');}
   await renameFile(from,to);await sync(path.dirname(from));await sync(path.dirname(to));
  }
  return await validSubset(destination,files)?{state:'preserved',destination}:held('recovery_tree_changed');
 }catch(e){return held(e.code==='EXDEV'?'cross_filesystem_move':'preservation_outcome_unknown');}
}
