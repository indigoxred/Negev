import assert from 'node:assert/strict';
import test from 'node:test';
import { readShokoPathFile } from '../src/acquisition/shoko-path-file.mjs';

test('reads only the exact path suffix through supported Shoko API', async () => {
  const seen = [];
  const result = await readShokoPathFile({ baseUrl: 'http://shoko:8111',
    apiKey: 'private', sourcePath: '/pure/Import/Negev/01.mkv',
    fetchImpl: async (url, init) => {
      seen.push([new URL(url).pathname,
        new URL(url).searchParams.get('path'),
        new URL(url).searchParams.getAll('include'),
        new URL(url).searchParams.get('limit'), init.headers.Authorization]);
      return Response.json([{ ID: 7, Size: 1000, SeriesIDs: [],
        Locations: [{ AbsolutePath: '/pure/Import/Negev/01.mkv',
          IsAccessible: true }] }]);
    } });
  assert.equal(result.state, 'files');
  assert.equal(result.items.length, 1);
  assert.deepEqual(seen, [['/api/v3/File/PathEndsWith',
    '/pure/Import/Negev/01.mkv', ['AbsolutePaths', 'XRefs'],
    '100', 'Bearer private']]);
});

test('exact-ID nomination uses the same bounded raw file reader and rejects another ID', async () => {
  const {readShokoFileById}=await import('../src/acquisition/shoko-path-file.mjs');
  let reads=0;
  const input={baseUrl:'http://shoko:8111',apiKey:'synthetic',fileId:81,
    fetchImpl:async(url,init)=>{reads++;assert.equal(new URL(url).pathname,'/api/v3/File/81');assert.equal(init.method,'GET');return Response.json({ID:81,Size:5,Locations:[],SeriesIDs:[]});}};
  assert.equal((await readShokoFileById(input)).items[0].ID,81);
  assert.equal((await readShokoFileById({...input,fetchImpl:async()=>Response.json({ID:82})})).state,'unavailable');
  await assert.rejects(()=>readShokoFileById({...input,sourcePath:'/pure/a.mkv'}),TypeError);
  assert.equal(reads,1);
});
