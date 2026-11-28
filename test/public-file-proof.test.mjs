import test from 'node:test';
import assert from 'node:assert/strict';
import { includesProvenFile } from '../src/availability/multipart-availability.mjs';

test('scalar IDs cannot replace the journalled physical public witness',()=>{
 assert.equal(includesProvenFile({state:'available',fileId:81},81,'1:2:1000'),false);
 assert.equal(includesProvenFile({state:'available',fileId:81,proof:{fileId:81,storageKey:'1:2:1000'}},81,'1:2:1000'),true);
 assert.equal(includesProvenFile({state:'available',fileId:81,proof:{fileId:81,storageKey:'1:3:1000'}},81,'1:2:1000'),false);
 assert.equal(includesProvenFile({state:'available',fileId:81,proof:{fileId:82,storageKey:'1:2:1000'}},81,'1:2:1000'),false);
});

test('a multipart flag cannot authorize an incomplete or reordered proof',()=>{
 const parts=[0,1].map(i=>({fileId:81+i,partId:91+i,libraryId:102,ratingKey:500,mediaId:700,partIndex:i,partCount:2,storageKey:`1:${2+i}:1000`}));
 const result={state:'available',fileId:81,multipart:true,proof:{parts}};
 assert.equal(includesProvenFile(result,82,'1:3:1000'),true);
 assert.equal(includesProvenFile({...result,proof:{parts:parts.slice(0,1)}},81,'1:2:1000'),false);
 assert.equal(includesProvenFile({...result,proof:{parts:[...parts].reverse()}},82,'1:3:1000'),false);
 assert.equal(includesProvenFile({...result,proof:{parts:parts.map(p=>({...p,mediaId:undefined}))}},82,'1:3:1000'),false);
});
