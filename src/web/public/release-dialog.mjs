import { compactReleaseRow } from './release-row.mjs';
import { releaseFacts } from './release-choice-fields.mjs';
export function makeReleaseActions(element,{onAuto,onManual}) {
  const container=element('div',undefined,'release-mode-actions');
  const auto=element('button','Auto-Pick','primary');
  const manual=element('button','Manual Pick');
  auto.type=manual.type='button';auto.addEventListener('click',onAuto);manual.addEventListener('click',onManual);
  container.append(auto,manual);return {element:container,auto,manual};
}
export function createReleaseDialog({api,element,onSaved=()=>{}}) {
  let active=null;
  const closeActive=()=>{
    const previous=active;
    if(previous){previous.close();previous.remove();if(active===previous)active=null;}
  };
  const errorText=e=>({release_search_unavailable:'Indexers could not be reached. Retry search.',
    release_search_incomplete:'Some indexers could not be reached. Retry search.',
    release_already_processing:'This request already has files being processed. Its existing download is preserved.',
    stale_release_selection:'This request changed. Reopen release selection to see the current choice.',
    release_search_expired:'These results expired. Search again before selecting.',
    release_title_mismatch:'This release does not safely match the requested installment.',
    related_title_unavailable:'Related installments could not be checked. Retry inspection.',
    release_not_eligible:'This release does not meet the current release preferences.',
    target_already_available:'These episodes are already available. No new download is needed.',
    target_already_owned:'These files are already owned and are being verified. No duplicate download will start.'}[e.reason]??e.message??'Could not complete release selection. Retry.');
  const open=async({requestId,title,mode='manual',next=null})=>{
    closeActive();
    const dialog=element('dialog',undefined,'release-search-dialog');active=dialog;
    dialog.setAttribute('aria-label',`Release selection · ${title}`);
    const header=element('div',undefined,'season-request-popup-heading');
    const close=element('button','Close','quiet');close.addEventListener('click',()=>dialog.close());
    header.append(element('h2',title),close);
    const status=element('p','Loading saved selection…','muted');status.setAttribute('role','status');
    const actions=element('div',undefined,'release-search-actions');
    const auto=element('button','Auto-Pick',mode==='auto'?'primary':'quiet'),manual=element('button','Manual Pick',mode==='manual'?'primary':'quiet');
    const modes=element('div',undefined,'release-mode-actions');modes.append(auto,manual);
    const makeFilter=(label,options)=>{const wrapper=element('label',label);const select=element('select');select.setAttribute('aria-label',label);
      for(const [value,text]of options){const option=element('option',text);option.value=value;select.append(option);}wrapper.append(select);actions.append(wrapper);return select;};
    const quality=makeFilter('Quality',[['bd1080','BD / 1080p+'],['1080','1080p+'],['720','720p+'],['bd','BD only'],['all','All qualities']]);
    const audio=makeFilter('Audio',[['japanese','Japanese'],['japanese_dual','Japanese + dual'],['dual','Dual audio'],['english','English dub']]);
    const searchButton=element('button','Search');
    const preferLabel=element('label',undefined,'release-prefer-future');preferLabel.hidden=true;
    const preferFuture=element('input');preferFuture.type='checkbox';preferFuture.setAttribute('aria-label','Prefer this release group for future episodes');
    preferLabel.append(preferFuture,element('span','Prefer this release group for future episodes'));
    preferLabel.title='For new airing episodes, wait up to two hours after another suitable release appears, then use an available alternative.';
    const preferenceEditor=element('details',undefined,'release-preference-editor');preferenceEditor.hidden=true;
    const preferenceSummary=element('summary','Edit future release preference');
    const groupInput=element('input');groupInput.maxLength=80;groupInput.placeholder='Preferred release group';groupInput.setAttribute('aria-label','Preferred release group');
    const saveGroup=element('button','Save group','quiet'),clearGroup=element('button','Clear preference','quiet');
    preferenceEditor.append(preferenceSummary,groupInput,saveGroup,clearGroup);
    const query=element('input');query.type='search';query.placeholder='Refine release search…';query.maxLength=120;
    query.setAttribute('aria-label','Release search phrase');
    actions.append(query,searchButton);actions.hidden=mode==='auto';
    const results=element('div',undefined,'release-results');
    dialog.append(header,modes,actions,preferLabel,preferenceEditor,status,results);
    if(next) {
      const nextButton=element('button','Next selected installment','quiet');
      nextButton.addEventListener('click',()=>{dialog.close();next();});dialog.append(nextButton);
    }
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('close',()=>{if(active===dialog)active=null;dialog.remove();},{once:true});
    let control,busy=false,version=0,expiryTimer=null,nextButton=null,lastQuery='';
    const shown=new Set();let confirmedAiring=false,preferenceInitialized=false;
    dialog.addEventListener('close',()=>clearTimeout(expiryTimer),{once:true});
    const current=()=>dialog.isConnected&&active===dialog;
    const command=body=>api(`/api/requests/${requestId}/release-choice`,{method:'POST',body:JSON.stringify({...body,revision:control.revision})});
    const updateContext=ctx=>{
      if(!ctx)return;confirmedAiring=ctx.confirmedAiring===true;preferenceEditor.hidden=!confirmedAiring;
      if(!preferenceInitialized){preferFuture.checked=Boolean(ctx.preferredGroup);preferenceInitialized=true;}
      if(document.activeElement!==groupInput)groupInput.value=ctx.preferredGroup??'';
      preferenceSummary.textContent=ctx.preferredGroup?'Preferred group: '+ctx.preferredGroup:'Edit future release preference';
    };
    const refresh=async()=>{const data=await api(`/api/requests/${requestId}/release-choice`);control=data.control;updateContext(data.context);return control;};
    const buttons=value=>{busy=value;for(const input of [auto,manual,searchButton,quality,audio,query,preferFuture,saveGroup,clearGroup,groupInput])input.disabled=value;};
    const selectionSummary=selection=>{
      const box=element('div',undefined,'release-entry');
      box.append(element('strong',selection.candidate.title));
      box.append(element('p',`${selection.candidate.source} · ${selection.candidate.resolution??'?'}p · ${selection.candidate.seeders??'?'} seeds · ${selection.preview.episodeIds.length} requested episode(s)`,'muted'));
      box.append(element('p',selection.registration==='confirmed'?'Previously verified exact AniDB files':
        selection.registration==='likely'?'Likely AniDB correspondence · CRC32 and size':'Registration unknown',selection.registration==='confirmed'?'registration-confirmed':'registration-unknown'));
      return box;
    };
    const showControl=()=>{
      clearTimeout(expiryTimer);
      results.replaceChildren();preferLabel.hidden=!(confirmedAiring&&control.phase==='chosen');
      if(control.phase==='proposal') {
        expiryTimer=setTimeout(async()=>{
          if(!current())return;
          try{await refresh();if(current())showControl();}catch{}
        },Math.max(1000,Math.min(300_000,control.expiresMs-Date.now()+250)));
        status.textContent='There’s a better release available. It is potentially unlisted in AniDB and might remain unrecognized in Shoko and require manual review. Grab it anyway?';
        results.append(element('p',control.proposal.benefit));
        results.append(selectionSummary(control.proposal.better),element('p','Registered alternative:'),selectionSummary(control.proposal.registered));
        results.append(element('p','If unanswered, Negev uses the registered release after five minutes.','muted'));
        for(const [action,label] of [['better','Grab better release'],['registered','Use registered release']]) {
          const button=element('button',label,action==='better'?'primary':'');
          button.addEventListener('click',async()=>{
            if(busy)return;buttons(true);button.disabled=true;
            try{const data=await command({action});control=data.control;updateContext(data.context);showControl();onSaved();}
            catch(e){status.textContent=errorText(e);}finally{buttons(false);button.disabled=false;}
          });results.append(button);
        }
      } else if(control.phase==='chosen') {
        status.textContent='Exact release saved. Negev will check availability and process this choice; it will not substitute another release.';
        results.append(selectionSummary(control.selection));
      } else status.textContent=control.mode==='manual'&&control.phase==='selecting'
        ?'Choose a release below. This request will not start an automatic grab while you select.'
        :'Automatic acquisition is enabled. Search is read-only until you select a release.';
    };
    const search=async(append=false,offset=0)=>{
      if(busy)return;
      const phrase=query.value.trim();const filterKey=JSON.stringify([phrase,quality.value,audio.value]);
      if(filterKey!==lastQuery){append=false;offset=0;}lastQuery=filterKey;actions.hidden=false;
      buttons(true);if(nextButton)nextButton.disabled=true;
      const epoch=++version;status.textContent='Searching indexers…';
      if(!append){results.replaceChildren();shown.clear();nextButton=null;}
      if(!append){const headings=element('div',undefined,'release-results-heading');
        for(const label of ['Title','Group','Quality','Size','Seeds','Audio',''])headings.append(element('span',label));results.append(headings);}
      try{
        const params=new URLSearchParams({quality:quality.value,audio:audio.value});if(phrase)params.set('query',phrase);if(offset)params.set('offset',String(offset));
        const data=await api(`/api/requests/${requestId}/releases${params.size?`?${params}`:''}`);
        if(!current()||epoch!==version)return;
        nextButton?.remove();nextButton=null;updateContext(data);preferLabel.hidden=!confirmedAiring;
        if(!confirmedAiring)preferFuture.checked=false;
        status.textContent=data.waitingFor==='first_episode'?'No released episodes to search yet. This request watches for the first release.':
          data.items.length?`${data.items.length} matching releases · audio and quality are advertised hints.`:'No matches returned. Refine the title or retry search.';
        for(const c of data.items) {
          const key=`${c.indexerId}:${c.guid}`;if(shown.has(key))continue;shown.add(key);
          results.append(compactReleaseRow({candidate:c,element,
            inspect:()=>command({action:'inspect',token:c.token}),
            choose:async()=>{
              await refresh();
              if(control.phase!=='selecting'||control.mode!=='manual') {
                const begun=await command({action:'begin',mode:'manual'});control=begun.control;
              }
              return command({action:'choose',token:c.token,preferFutureGroup:confirmedAiring&&preferFuture.checked});
            },isCurrent:current,isBusy:()=>busy,setBusy:buttons,
            onError:error=>{const text=errorText(error);status.textContent=text;return text;},
            onSelected:data=>{control=data.control;updateContext(data.context);showControl();onSaved();}}));
        }
        if(data.nextOffset!==null&&data.nextOffset!==undefined) {
          nextButton=element('button','Show more releases','quiet');
          nextButton.addEventListener('click',()=>{void search(true,data.nextOffset);});results.append(nextButton);
        }
      }catch(e){if(current())status.textContent=errorText(e);}finally{buttons(false);if(nextButton)nextButton.disabled=false;}
    };
    const runAuto=async()=>{
      if(busy)return;buttons(true);version++;actions.hidden=true;preferLabel.hidden=true;
      try{
        await refresh();
        if(control.phase==='proposal'){showControl();return;}
        if(control.phase!=='selecting'||control.mode!=='auto') {
          const begun=await command({action:'begin',mode:'auto'});control=begun.control;
        }
        status.textContent='Comparing eligible releases…';results.replaceChildren();
        const data=await command({action:'auto'});control=data.control;updateContext(data.context);if(current())showControl();onSaved();
      }catch(e){if(current())status.textContent=errorText(e);}finally{buttons(false);}
    };
    const savePreference=async group=>{
      if(busy)return;buttons(true);
      try{await refresh();const data=await command({action:'preference',group,audio:audio.value==='english'?'english':audio.value==='dual'?'dual':'japanese'});
        control=data.control;updateContext(data.context);preferFuture.checked=Boolean(control.preference?.group);status.textContent=group?'Future release preference saved.':'Future release preference cleared.';onSaved();}
      catch(error){status.textContent=errorText(error);}finally{buttons(false);}
    };
    saveGroup.addEventListener('click',()=>{void savePreference(groupInput.value.trim()||null);});
    clearGroup.addEventListener('click',()=>{void savePreference(null);});
    preferFuture.addEventListener('change',()=>{
      if(control.phase!=='chosen'||!control.selection)return;
      const group=releaseFacts(control.selection.candidate.title).group;
      if(preferFuture.checked&&!group){preferFuture.checked=false;status.textContent='This release does not advertise a group. You can set one under future release preference.';return;}
      void savePreference(preferFuture.checked?group:null);
    });
    auto.addEventListener('click',runAuto);manual.addEventListener('click',()=>{void search();});searchButton.addEventListener('click',()=>{void search();});
    quality.addEventListener('change',()=>{void search();});audio.addEventListener('change',()=>{void search();});
    query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void search();}});
    try{await refresh();if(!current())return;showControl();if(control.phase==='proposal'||control.phase==='chosen')return;
      if(mode==='auto')await runAuto();else await search();
    }catch(e){if(current())status.textContent=errorText(e);}
  };
  return {open,close:closeActive};
}
