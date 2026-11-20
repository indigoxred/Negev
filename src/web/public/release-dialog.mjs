const registrationText=state=>state==='previously_verified'?'Previously verified exact AniDB file':
  state==='likely'?'Likely AniDB correspondence · advertised CRC32 and size':
    state==='filename_prediction'?'Filename prediction only · registration unknown':'Registration unknown';
export function makeReleaseModePicker(element) {
  const field=element('label','Release selection','release-mode');
  const select=element('select');select.setAttribute('aria-label','Release selection');
  for(const [value,label] of [['auto_review','Auto search'],['manual','Search releases']]) {
    const option=element('option',label);option.value=value;select.append(option);
  }
  field.append(select);return {element:field,value:()=>select.value};
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
    header.append(element('h2',`Releases · ${title}`),close);
    const status=element('p','Loading saved selection…','muted');status.setAttribute('role','status');
    const actions=element('div',undefined,'release-search-actions');
    const auto=element('button','Auto search','primary'),manual=element('button','Search releases');
    const query=element('input');query.type='search';query.placeholder='Refine release search…';query.maxLength=120;
    query.setAttribute('aria-label','Release search phrase');
    actions.append(auto,query,manual);
    const results=element('div',undefined,'release-results');
    dialog.append(header,element('p',`Request #${requestId} · ${title}`,'muted'),actions,status,results);
    if(next) {
      const nextButton=element('button','Next selected installment','quiet');
      nextButton.addEventListener('click',()=>{dialog.close();next();});dialog.append(nextButton);
    }
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('close',()=>{if(active===dialog)active=null;dialog.remove();},{once:true});
    let control,busy=false,version=0,expiryTimer=null,nextButton=null,lastQuery='';
    const shown=new Set();
    dialog.addEventListener('close',()=>clearTimeout(expiryTimer),{once:true});
    const current=()=>dialog.isConnected&&active===dialog;
    const command=body=>api(`/api/requests/${requestId}/release-choice`,{method:'POST',body:JSON.stringify({...body,revision:control.revision})});
    const refresh=async()=>{const data=await api(`/api/requests/${requestId}/release-choice`);control=data.control;return control;};
    const buttons=value=>{busy=value;auto.disabled=value;manual.disabled=value;};
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
      results.replaceChildren();
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
            try{const data=await command({action});control=data.control;showControl();onSaved();}
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
      const phrase=query.value.trim();
      if(phrase!==lastQuery){append=false;offset=0;}lastQuery=phrase;
      buttons(true);if(nextButton)nextButton.disabled=true;
      const epoch=++version;status.textContent='Searching indexers…';
      if(!append){results.replaceChildren();shown.clear();nextButton=null;}
      try{
        const params=new URLSearchParams();if(phrase)params.set('query',phrase);if(offset)params.set('offset',String(offset));
        const data=await api(`/api/requests/${requestId}/releases${params.size?`?${params}`:''}`);
        if(!current()||epoch!==version)return;
        nextButton?.remove();nextButton=null;
        status.textContent=data.waitingFor==='first_episode'?'No released episodes to search yet. This request watches for the first release.':
          data.items.length?`${data.items.length} matches · advertised information is provisional. Inspect files before selecting.`:'No matches returned. Refine the title or retry search.';
        for(const c of data.items) {
          const key=`${c.indexerId}:${c.guid}`;if(shown.has(key))continue;shown.add(key);
          const entry=element('article',undefined,'release-entry');
          entry.append(element('strong',c.title));
          entry.append(element('p',`${c.group} · ${c.source} · ${c.resolution?`${c.resolution}p`:'Resolution unknown'} · ${(c.size/1_073_741_824).toFixed(2)} GiB · ${c.seeders??'?'} seeds · ${c.indexer}`,'muted'));
          entry.append(element('p',`${c.coverage} · ${c.languageHints}`,'muted'));
          if(!c.eligible)entry.append(element('p',({no_reported_seeders:'No reported seeders',english_dub_only:'English dub only · outside Japanese-audio preference',no_english_subtitles:'No English subtitles advertised',outside_quality_profile:'Outside the current quality profile'}[c.reason]??'Outside the current release preferences'),'muted'));
          const evidence=element('p','Registration unknown','registration-unknown');entry.append(evidence);
          const inspect=element('button','Inspect files'),grab=element('button','Grab this release','primary');grab.disabled=true;
          const files=element('details');files.append(element('summary','File coverage and registration evidence'));
          inspect.addEventListener('click',async()=>{
            inspect.disabled=true;grab.disabled=true;evidence.textContent='Reading exact torrent file list…';
            try{
              const preview=await command({action:'inspect',token:c.token});
              if(!current())return;
              files.replaceChildren(element('summary',`${preview.files.length} video files · ${preview.episodeIds.length} requested episodes`));
              let confirmed=preview.files.length>0;
              for(const f of preview.files) {
                const proof=preview.correspondence?.files?.find(p=>p.name===f.name&&p.size===f.size);
                confirmed&&=proof?.state==='previously_verified';
                files.append(element('p',`${f.name} → AniDB episode ${f.episodeIds.join(', ')} · ${registrationText(proof?.state)}`));
              }
              for(const f of preview.filesToExclude??[])files.append(element('p',`${f.name} · excluded from this request`,'muted'));
              evidence.className=confirmed?'registration-confirmed':'registration-unknown';
              evidence.textContent=confirmed?'Previously verified exact AniDB files':'See per-file evidence · registration is not confirmed for this whole release';
              grab.disabled=!c.eligible||['already_available','owned_unverified'].includes(preview.selectionStatus);
              if(preview.selectionStatus==='already_available')grab.textContent='Already available';
              if(preview.selectionStatus==='owned_unverified')grab.textContent='Already owned · verification pending';
              files.open=true;
            }catch(e){evidence.textContent=errorText(e);}finally{inspect.disabled=false;}
          });
          grab.addEventListener('click',async()=>{
            if(busy)return;buttons(true);grab.disabled=true;
            try{
              await refresh();
              if(control.phase!=='selecting'||control.mode!=='manual') {
                const begun=await command({action:'begin',mode:'manual'});control=begun.control;
              }
              const data=await command({action:'choose',token:c.token});control=data.control;
              if(current())showControl();onSaved();
            }catch(e){status.textContent=errorText(e);}finally{buttons(false);grab.disabled=false;}
          });
          entry.append(inspect,grab,files);results.append(entry);
        }
        if(data.nextOffset!==null&&data.nextOffset!==undefined) {
          nextButton=element('button','Show more releases','quiet');
          nextButton.addEventListener('click',()=>{void search(true,data.nextOffset);});results.append(nextButton);
        }
      }catch(e){if(current())status.textContent=errorText(e);}finally{buttons(false);if(nextButton)nextButton.disabled=false;}
    };
    const runAuto=async()=>{
      if(busy)return;buttons(true);version++;
      try{
        await refresh();
        if(control.phase==='proposal'){showControl();return;}
        if(control.phase!=='selecting'||control.mode!=='auto') {
          const begun=await command({action:'begin',mode:'auto'});control=begun.control;
        }
        status.textContent='Comparing eligible releases…';results.replaceChildren();
        const data=await command({action:'auto'});control=data.control;if(current())showControl();onSaved();
      }catch(e){if(current())status.textContent=errorText(e);}finally{buttons(false);}
    };
    auto.addEventListener('click',runAuto);manual.addEventListener('click',()=>{void search();});
    query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void search();}});
    try{await refresh();if(!current())return;showControl();if(control.phase==='proposal'||control.phase==='chosen')return;
      if(mode==='auto')await runAuto();else await search();
    }catch(e){if(current())status.textContent=errorText(e);}
  };
  return {open,close:closeActive};
}
