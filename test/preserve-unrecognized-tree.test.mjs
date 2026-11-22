import assert from 'node:assert/strict';
import { mkdir, mkdtemp, lstat, readFile, rm, writeFile } from
  'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preserveUnrecognizedTree } from
  '../src/acquisition/preserve-unrecognized-tree.mjs';

test('moves the exact published tree once, preserving file identity and replaying after restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'negev-recover-tree-'));
  try {
    const importRoot = path.join(root, 'Import');
    const holdingRoot = path.join(root, 'holding');
    const torrentHash = 'a'.repeat(40);
    const attemptId = 7;
    const name = `negev-${attemptId}-${torrentHash.slice(0, 16)}`;
    const source = path.join(importRoot, name);
    await mkdir(source, { recursive: true });
    await mkdir(holdingRoot);
    await writeFile(path.join(source, '01.mkv'), 'media');
    const stat = await lstat(path.join(source, '01.mkv'), { bigint: true });
    const manifest = { attemptId, torrentHash,
      holdingPath: path.join(holdingRoot, name),
      files: [{ name: '01.mkv', size: 5, episodeIds: [1001],
        dev: String(stat.dev), ino: String(stat.ino),
        mtimeNs: String(stat.mtimeNs) }] };
    let checks = 0;
    const run = () => preserveUnrecognizedTree({ manifest, importRoot,
      holdingRoot, recheck: async () => { checks++; return {
        state: 'unrecognized_confirmed', fileId: 81 }; } });
    assert.equal((await run()).state, 'preserved');
    assert.equal(await readFile(path.join(holdingRoot,
      `recovered-${name}`, '01.mkv'), 'utf8'), 'media');
    assert.equal((await run()).state, 'preserved');
    assert.equal(checks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function mixedFixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'negev-mixed-preserve-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const importRoot=path.join(root,'Import'),holdingRoot=path.join(root,'holding'),torrentHash='a'.repeat(40),attemptId=7,name=`negev-${attemptId}-${torrentHash.slice(0,16)}`,source=path.join(importRoot,name);
 await mkdir(source,{recursive:true});await mkdir(holdingRoot);const files=[];
 for(const [fileName,body,extra]of [['Film.mkv','main',{episodeIds:[1001]}],['Film.eng.srt','sub',{}],['Trailer.mkv','bonus',{scope:'bonus',anidbId:42,kind:'extra',episodeIds:[2001]}],['Trailer.eng.srt','bonussub',{}]]){
  await writeFile(path.join(source,fileName),body);const s=await lstat(path.join(source,fileName),{bigint:true});files.push({name:fileName,size:body.length,...extra,dev:String(s.dev),ino:String(s.ino),mtimeNs:String(s.mtimeNs)});
 }
 return {root,source,importRoot,holdingRoot,destination:path.join(holdingRoot,`recovered-${name}`),manifest:{attemptId,torrentHash,holdingPath:path.join(holdingRoot,name),files},fileId:81,recheck:async()=>({state:'unrecognized_confirmed',fileId:81})};
}
test('mixed recovery preserves only main video and its sidecar when Shoko already moved a bonus',async t=>{
 const f=await mixedFixture(t);const {rename}=await import('node:fs/promises');await mkdir(path.join(f.root,'Anime'));await rename(path.join(f.source,'Trailer.mkv'),path.join(f.root,'Anime','Trailer.mkv'));
 assert.equal((await preserveUnrecognizedTree(f)).state,'preserved');
 assert.equal(await readFile(path.join(f.destination,'Film.mkv'),'utf8'),'main');assert.equal(await readFile(path.join(f.destination,'Film.eng.srt'),'utf8'),'sub');
 assert.equal(await readFile(path.join(f.source,'Trailer.eng.srt'),'utf8'),'bonussub');assert.equal(await readFile(path.join(f.root,'Anime','Trailer.mkv'),'utf8'),'bonus');
 assert.equal(String((await lstat(path.join(f.destination,'Film.mkv'),{bigint:true})).ino),f.manifest.files[0].ino);
 assert.equal((await preserveUnrecognizedTree(f)).state,'preserved');
});
test('mixed preservation resumes a crash after a sidecar rename without moving bonus files',async t=>{
 const f=await mixedFixture(t);const {rename}=await import('node:fs/promises');let count=0;
 const interrupted=await preserveUnrecognizedTree({...f,renameTree:async(from,to)=>{if(++count===2)throw new Error('controlled interruption');await rename(from,to);}});
 assert.equal(interrupted.state,'held');assert.equal((await preserveUnrecognizedTree(f)).state,'preserved');
 assert.equal(await readFile(path.join(f.source,'Trailer.mkv'),'utf8'),'bonus');
});

test('mixed recovery resumes known empty destination directories without overwriting collisions',async t=>{
 const f=await mixedFixture(t);const {rename}=await import('node:fs/promises');await mkdir(path.join(f.source,'Pack'));
 for(const file of f.manifest.files){await rename(path.join(f.source,file.name),path.join(f.source,'Pack',file.name));file.name='Pack/'+file.name;}
 await mkdir(f.destination,{recursive:true});
 assert.equal((await preserveUnrecognizedTree(f)).state,'preserved');
 assert.equal(await readFile(path.join(f.source,'Pack','Trailer.mkv'),'utf8'),'bonus');
});
test('a changed mixed file, unrelated recovery destination or source symlink cannot move media',async t=>{
 for(const failure of ['changed','collision','symlink']){
  const f=await mixedFixture(t);
  if(failure==='changed')await writeFile(path.join(f.source,'Film.mkv'),'changed');
  if(failure==='collision'){await mkdir(f.destination);await writeFile(path.join(f.destination,'unrelated.mkv'),'keep');}
  if(failure==='symlink'){const {rename,symlink}=await import('node:fs/promises');const real=f.source+'-real';await rename(f.source,real);await symlink(real,f.source,process.platform==='win32'?'junction':'dir');}
  assert.equal((await preserveUnrecognizedTree(f)).state,'held',failure);
  assert.equal(await readFile(path.join(f.source,'Trailer.mkv'),'utf8'),'bonus');
 }
});
