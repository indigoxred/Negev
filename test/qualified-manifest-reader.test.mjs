import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,chmod,symlink,mkdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {readQualifiedManifest} from '../src/availability/migrate-qualified-cache.mjs';
test('migration reads a bounded private manifest and rejects symlinks and outside paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'qualified-reader-')),data=path.join(root,'data');await mkdir(data,{mode:0o700});const file=path.join(data,'manifest.json');await writeFile(file,'{"formatVersion":1}',{mode:0o600});
 try{assert.equal((await readQualifiedManifest({dataDir:data,filePath:file})).formatVersion,1);const outside=path.join(root,'outside.json');await writeFile(outside,'{}',{mode:0o600});await assert.rejects(readQualifiedManifest({dataDir:data,filePath:outside}));if(process.platform!=='win32'){const link=path.join(data,'link');await symlink(file,link);await assert.rejects(readQualifiedManifest({dataDir:data,filePath:link}));await chmod(file,0o644);await assert.rejects(readQualifiedManifest({dataDir:data,filePath:file}));}}
 finally{await rm(root,{recursive:true,force:true});}
});
