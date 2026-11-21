import test from 'node:test';
import assert from 'node:assert/strict';
import { requestNeedsReleaseChoice } from '../src/web/public/request-progress-text.mjs';

const waiting = {status:'held',releaseSelection:{mode:'manual',phase:'selecting'},progress:{state:'saved',targetCount:24,publicAvailability:'unverified',publicVerifiedTargets:0}};
test('release tools are offered only while a request needs a choice',()=>{
  assert.equal(requestNeedsReleaseChoice(waiting),true);
  assert.equal(requestNeedsReleaseChoice({...waiting,releaseSelection:{mode:'auto',phase:'proposal'}}),true);
  for(const phase of ['chosen','consumed',undefined])assert.equal(requestNeedsReleaseChoice({...waiting,releaseSelection:{phase}}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,releaseSelection:null}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,status:'cancelled'}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,progress:{...waiting.progress,oneTimeAcquisitionComplete:true}}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,progress:{...waiting.progress,publicAvailability:'verified_recently',publicVerifiedTargets:24}}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,progress:{...waiting.progress,transfer:{transferState:'active'}}}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,progress:{...waiting.progress,transfer:{transferState:'queued'}}}),false);
  assert.equal(requestNeedsReleaseChoice({...waiting,progress:{...waiting.progress,publicAvailability:'verified_recently',publicVerifiedTargets:8}}),true);
});
