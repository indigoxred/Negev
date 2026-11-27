import test from 'node:test';
import assert from 'node:assert/strict';
import { requestNeedsReleaseChoice,requestHasPendingAcquisition,requestCanEditReleasePreference } from '../src/web/public/request-progress-text.mjs';

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

import { createRequestController } from '../src/web/public/request-controller.mjs';
const { requestItemPresentation: present } = createRequestController({});
test('a fulfilled stale manual or auto proposal presents completion rather than an inaccessible picker',()=>{
 for(const releaseSelection of [{mode:'manual',phase:'selecting'},{mode:'auto',phase:'proposal'}]){
  const item={...waiting,kind:'series',releaseSelection,monitorFuture:true,watchClosed:false,progress:{...waiting.progress,publicAvailability:'verified_recently',publicVerifiedTargets:24}};
  assert.equal(requestNeedsReleaseChoice(item),false);
  assert.equal(present(item).stage,'Watching for the next episode');
 }
});

test('future preference controls remain independent of completion and consumed choices',()=>{
 const item={...waiting,kind:'series',monitorFuture:true,watchClosed:false,releaseSelection:null,progress:{...waiting.progress,publicAvailability:'verified_recently',publicVerifiedTargets:24}};
 assert.equal(requestCanEditReleasePreference(item),true);
 for(const extra of [{status:'cancelled'},{kind:'movie'},{monitorFuture:false},{watchClosed:true}])assert.equal(requestCanEditReleasePreference({...item,...extra}),false);
 assert.equal(present({...item,preferredWait:{group:'SubsPlease',deadlineMs:Date.now()+3600000}}).stage,'Watching for the next episode');
 assert.equal(present({...item,status:'cancelled'}).stage,'Cancelled');
});
