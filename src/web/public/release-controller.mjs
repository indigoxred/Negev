import { createReleaseDialog } from './release-dialog.mjs';
import { requestFailureMessage, savedRequestMessage } from './request-feedback.mjs';

// Owns release preview callbacks and dialog sequencing. Construction does not register event handlers.
export function createReleaseController({
  dialog,
  api,
  element,
  loadRequests,
  message,
  preferredDisplayTitle,
  refreshTrackingAfterRequest,
  sessionResponses,
  state,
  document = globalThis.document,
  location = globalThis.location
}) {
  const releasePreviewSaved=new Map();

  const releaseDialog=dialog ?? createReleaseDialog({api,element,onSaved:data=>{
    if(data?.previewId&&(!Number.isSafeInteger(data.requestId)||data.requestId<1))return;
    const saved=releasePreviewSaved.get(data?.previewId);
    if(saved){releasePreviewSaved.delete(data.previewId);saved(data);refreshTrackingAfterRequest();}
    void loadRequests();
  }});

  function dismissRequestDialogs() {
    releaseDialog.close();
    // Hiding an ancestor does not close a native modal: it still makes the
    // newly visible page inert. Release the top layer before changing views.
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  }

  async function openPreviewReleaseRequests(jobs) {
    if(!state.releaseSearch)return;
    const session=sessionResponses.current(),route=location.hash;
    const show=async index=>{
      if(!state.user||!sessionResponses.isCurrent(session)||location.hash!==route)return;
      const item=jobs[index];if(!item)return;
      try{
        const preview=await api('/api/release-previews',{method:'POST',body:JSON.stringify(item.body)});
        if(!state.user||!sessionResponses.isCurrent(session)||location.hash!==route)return;
        if(preview.state==='pending') {
          item.saved(preview);refreshTrackingAfterRequest();void loadRequests();
          message(savedRequestMessage(preview));
          if(index+1<jobs.length)void show(index+1);
          return;
        }
        if(preview.state==='existing') {
          item.saved(preview);refreshTrackingAfterRequest();void loadRequests();
          void releaseDialog.open({requestId:preview.requestId,title:preferredDisplayTitle(item),existing:true,
            next:index+1<jobs.length?()=>{void show(index+1);}:null});
          return;
        }
        if(preview.state!=='preview'||typeof preview.previewId!=='string')throw new Error(preview.reason??'Release preview unavailable');
        while(releasePreviewSaved.size>=100)releasePreviewSaved.delete(releasePreviewSaved.keys().next().value);
        const previewUserId=state.user.id;
        releasePreviewSaved.set(preview.previewId,result=>{
          if(state.user?.id===previewUserId)item.saved(result);
        });
        void releaseDialog.open({previewId:preview.previewId,title:preferredDisplayTitle(item),mode:'manual',
          next:index+1<jobs.length?()=>{void show(index+1);}:null});
      }catch(error){
        message(requestFailureMessage(error),true);
        if(![401,403].includes(error.status)&&
            (error.reason??error.message)!=='account_access_changed'&&index+1<jobs.length)await show(index+1);
      }
    };
    await show(0);
  }

  async function openSavedReleaseRequests(saved,mode) {
    if(!state.releaseSearch)return;
    const session = sessionResponses.current();
    const route = location.hash;
    const jobs=saved.filter(item=>Number.isSafeInteger(item.requestId));
    const show=index=>{
      if(!state.user || !sessionResponses.isCurrent(session) || location.hash!==route)return;
      const item=jobs[index];if(!item)return;
      void releaseDialog.open({requestId:item.requestId,title:preferredDisplayTitle(item),
        mode:mode==='manual'?'manual':'auto',
        next:index+1<jobs.length?()=>show(index+1):null});
    };
    show(0);
  }
  return { releaseDialog, dismissRequestDialogs, openPreviewReleaseRequests, openSavedReleaseRequests };
}
