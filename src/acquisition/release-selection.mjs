import { randomUUID } from 'node:crypto';
import { assessRelease, compareReleases, hasSeasonPackHint } from './release-preference.mjs';
import { releaseFacts, matchesReleaseFilters, validReleaseFilters, DEFAULT_RELEASE_FILTERS } from '../web/public/release-choice-fields.mjs';
import { inferReleaseState } from '../catalogue/infer-release-state.mjs';
import { validPreferredGroup } from './preferred-release.mjs';

const held=reason=>({state:'held',reason});
export function publicRelease(c) {
  const title=c.title;
  const facts=releaseFacts(title);
  const range=/\bS\d{1,2}E\d{1,3}\s*[-–]\s*(?:S\d{1,2}E|E)?\d{1,3}\b|\b0?1\s*[-–]\s*(?:1[0-9]|[2-9]\d?)\b/i.test(title);
  const coordinate=/\bS\d{1,2}E(\d{1,3})(?:v\d+)?\b/i.exec(title)?.[1]??
    /\s[-–]\s(\d{1,3})(?:v\d+)?(?=\s|$|[.\[(])/i.exec(title)?.[1];
  const coverage=!range&&coordinate?`Episode ${Number(coordinate)} advertised; inspect file coverage`:
    hasSeasonPackHint(c)||range?'Season pack advertised; inspect file coverage':'Inspect file coverage';
  const resolution=/\b1080p?\b|1920x1080/i.test(title)?1080:
    /\b720p?\b|1280x720/i.test(title)?720:/\b(?:480|576)p?\b/i.test(title)?480:null;
  return {guid:c.guid,indexerId:c.indexerId,title,size:c.size,seeders:c.seeders??null,
    evidence:'unverified',group:facts.group??'Not advertised',
    source:/\b(?:BD(?:rip|remux)?|Blu[ ._-]?ray)\b/i.test(title)?'Blu-ray':
      /\bDVD(?:rip)?\b/i.test(title)?'DVD':/\bWEB(?:[ ._-]?DL|rip)?\b/i.test(title)?'WEB':'Not advertised',
    resolution:facts.resolution,coverage,audio:facts.audio,audioLabel:facts.audioLabel,
    qualityLabel:[facts.source,facts.resolution?`${facts.resolution}p`:null].filter(Boolean).join(' ')||'Not specified',
    indexer:typeof c.indexer==='string'?c.indexer.slice(0,120):`Indexer ${c.indexerId}`,
    languageHints:/dual[ ._-]?audio|multi[ ._-]?audio|\bdual\b/i.test(title)?'Dual audio advertised; subtitles unverified':
      /\b(?:english|eng)[ ._-]*dub(?:bed)?\b|\bdub[ ._-]*only\b/i.test(title)?'English dub advertised; Japanese audio not advertised':
      /(?:eng(?:lish)?[ ._-]?subs?|multi[ ._-]?subs?|subsplease|erai[ ._-]?raws)/i.test(title)?
        'English subtitle hint advertised; tracks unverified':'Languages not advertised',
    eligible:assessRelease(c).eligible,reason:assessRelease(c).reason};
}
export function correspondenceLevel(preview) {
  const files=preview?.files;
  if (!files?.length) return 'unknown';
  const states=files.map(f=>preview.correspondence?.files?.find(e=>e.name===f.name&&e.size===f.size)?.state??'unknown');
  return states.every(s=>s==='previously_verified')?'confirmed':
    states.every(s=>['previously_verified','likely'].includes(s))?'likely':'unknown';
}
const coverageKey=s=>[...s.preview.episodeIds].sort((a,b)=>a-b).join(',');
export function chooseReleaseProposal(selections) {
  const ordered=selections.filter(s=>assessRelease(s.candidate).eligible)
    .sort((a,b)=>compareReleases(a.candidate,b.candidate));
  const strongest=ordered[0];
  if (!strongest) return {state:'empty'};
  // Registration is a recognition preference, never permission to drop the
  // resolution or viability tier. Source improvements can be offered explicitly.
  const resolution=publicRelease(strongest.candidate).resolution;
  const healthy=assessRelease(strongest.candidate).healthyPeers;
  const registered=ordered.find(s=>correspondenceLevel(s.preview)!=='unknown' &&
    publicRelease(s.candidate).resolution===resolution &&
    assessRelease(s.candidate).healthyPeers===healthy && coverageKey(s)===coverageKey(strongest));
  if (!registered) return {state:'selected',selection:strongest};
  const a=assessRelease(strongest.candidate),b=assessRelease(registered.candidate);
  const benefit=a.quality>b.quality?'Blu-ray source instead of the advertised web source':
    a.trusted&&!b.trusted?'Preferred trusted indexer source':
      a.seeders>=Math.max(10,b.seeders*3)?`More reported peers (${a.seeders} versus ${b.seeders})`:null;
  return strongest!==registered && benefit && correspondenceLevel(strongest.preview)==='unknown'
    ?{state:'proposal',registered,better:strongest,benefit}
    :{state:'selected',selection:registered};
}

// Candidate receipts are bounded and short-lived; the selected descriptor and
// exact torrent hash are persisted in the request ledger before any worker wake.
export function createReleaseSelection({requests,discoverCandidates,previewCandidate,
  readPublicCoverage,loadDetail,wake=()=>{},now=Date.now}) {
  const receipts=new Map();
  const inFlight=new Map();
  const contexts=new Map();
  const snapshot=id=>requests.getReleaseControl(id,now());
  const save=(id,revision,next)=>requests.updateReleaseControl(id,revision,next,now());
  const remember=(id,request,releaseState)=>{
    contexts.set(id,{confirmedAiring:request.kind==='series'&&request.monitorFuture&&!request.watchClosed&&releaseState==='airing',until:now()+300_000});
    while(contexts.size>100)contexts.delete(contexts.keys().next().value);
  };
  const context=async id=>{
    const request=requests.getRequest(id);let saved=contexts.get(id);
    if(!saved||saved.until<=now()){
      let state='unknown';try{if(loadDetail){const detail=await loadDetail({anidbId:request.anidbId,page:1});
        if(detail?.state==='details')state=inferReleaseState({...detail,today:new Date(now()).toISOString().slice(0,10)}).state;}}
      catch{/* Preference controls stay hidden until metadata is known. */}
      remember(id,request,state);saved=contexts.get(id);
    }
    return {confirmedAiring:saved.confirmedAiring,preferredGroup:snapshot(id).preference?.group??null};
  };
  const makePreference=(id,group,audio)=>{
    if(!validPreferredGroup(group))return null;
    const request=requests.getRequest(id),prior=snapshot(id).preference;
    return {group,audio:['english','dual'].includes(audio)?audio:'japanese',
      knownEpisodeIds:prior?.knownEpisodeIds??[...request.episodeIds],createdMs:prior?.createdMs??now()};
  };
  const cache=(requestId,candidate,preview=null)=>{
    for(const [key,value] of receipts) if(value.expiresMs<=now()) receipts.delete(key);
    while(receipts.size>=500) receipts.delete(receipts.keys().next().value);
    const token=randomUUID();receipts.set(token,{requestId,candidate,preview,expiresMs:now()+600_000});return token;
  };
  const receipt=(id,token)=>{
    const value=receipts.get(token);return value?.requestId===id&&value.expiresMs>now()?value:null;
  };
  const inspect=async(id,token,knownCoverage)=>{
    const found=receipt(id,token);if(!found) return held('release_search_expired');
    if(!found.preview) {
      try {found.preview=await previewCandidate({requestId:id,candidate:found.candidate});}
      catch {return held('torrent_preflight_unavailable');}
    }
    if(found.preview?.state==='preflight') {
      try {
        const coverage=knownCoverage??await readPublicCoverage(requests.getRequest(id));
        const available=new Set(coverage.availableEpisodeIds??[]);
        const owned=new Set(coverage.uncertainEpisodeIds??[]);
        found.preview={...found.preview,selectionStatus:found.preview.episodeIds.every(x=>available.has(x))?'already_available':
          found.preview.episodeIds.some(x=>owned.has(x))?'owned_unverified':'eligible'};
      } catch {found.preview={...found.preview,selectionStatus:'unchecked'};}
    }
    return found.preview;
  };
  const search=async(id,query,resultOffset=0,filters=DEFAULT_RELEASE_FILTERS)=>{
    if(filters!==null&&!validReleaseFilters(filters))return held('invalid_release_filters');
    const request=requests.getRequest(id);
    if(!request||request.status!=='held') return held('request_missing');
    if(!request.episodeIds.length) return {state:'candidates',requestId:id,items:[],waitingFor:'first_episode'};
    let result;
    try {result=await discoverCandidates({requestId:id,interactive:true,resultOffset,filters,...(query?{query}:{})});}
    catch {return held('release_search_unavailable');}
    if(result?.state!=='candidates') return result??held('release_search_unavailable');
    remember(id,request,result.releaseState);
    const items=result.items.filter(c=>filters===null||matchesReleaseFilters(c,filters)).map(c=>filters===null?c:
      {...c,selectionPolicy:{allowUhd:true,allowEnglishDub:filters.audio==='english'}});
    return {...result,...await context(id),
      items:items.sort(compareReleases).map(c=>({...publicRelease(c),token:cache(id,c)}))};
  };
  const begin=(id,mode,revision)=>{
    if(!['auto','manual'].includes(mode)) return held('invalid_release_selection');
    const updated=save(id,revision,{mode,phase:'selecting',...(mode==='auto'?{expiresMs:now()+300_000}:{})});
    if(updated.state==='updated') wake(id);
    return updated;
  };
  const choose=async(id,token,revision,preferFutureGroup=false)=>{
    const found=receipt(id,token);if(!found) return held('release_search_expired');
    if(!assessRelease(found.candidate).eligible) return held('release_not_eligible');
    const preview=await inspect(id,token);
    if(preview?.state!=='preflight') return preview??held('torrent_preflight_unavailable');
    if(['already_available','owned_unverified'].includes(preview.selectionStatus))return held(
      preview.selectionStatus==='already_available'?'target_already_available':'target_already_owned');
    if(!preview.episodeIds.length) return held('release_has_no_requested_episodes');
    let preference;
    const ctx=await context(id);
    if(preferFutureGroup){
      if(!ctx.confirmedAiring)return held('title_not_airing');
      const facts=releaseFacts(found.candidate.title);preference=makePreference(id,facts.group,facts.audio);
      if(!preference)return held('release_group_unavailable');
    }else if(ctx.confirmedAiring)preference=null;
    const updated=save(id,revision,{mode:'manual',phase:'chosen',
      ...(preference===undefined?{}:{preference}),selection:{candidate:found.candidate,preview}});
    if(updated.state==='updated') wake(id);
    return updated;
  };
  const auto=async(id,revision)=>{
    if(inFlight.has(id)) return held('release_search_in_progress');
    inFlight.set(id,true);
    try {
      const current=snapshot(id);
      if(current.revision!==revision || current.mode!=='auto'||current.phase!=='selecting') return held('stale_release_selection');
      const found=await search(id,undefined,0,null);
      if(found.state!=='candidates') return found;
      const request=requests.getRequest(id);
      const coverage=await readPublicCoverage(request);
      const available=new Set([...(coverage.availableEpisodeIds??[]),...(coverage.uncertainEpisodeIds??[])]);
      const preferPack=found.releaseState==='completed'&&request.kind==='series'&&request.episodeIds.filter(x=>!available.has(x)).length>1;
      const inspected=[];
      for(const c of found.items.filter(c=>c.eligible).sort((a,b)=>compareReleases(
        receipt(id,a.token).candidate,receipt(id,b.token).candidate,{preferSeasonPack:preferPack})).slice(0,3)) {
        const preview=await inspect(id,c.token,coverage);
        if(preview?.state!=='preflight'||preview.episodeIds.every(x=>available.has(x))||
          preview.episodeIds.some(x=>(coverage.uncertainEpisodeIds??[]).includes(x))) continue;
        if(preferPack&&request.episodeIds.some(x=>!available.has(x)&&!preview.episodeIds.includes(x))) continue;
        inspected.push({candidate:receipt(id,c.token).candidate,preview});
      }
      const proposal=chooseReleaseProposal(inspected);
      const proposed=proposal.selection??proposal.registered;
      if(proposal.state==='empty'||found.searchIncomplete===true&&
          (publicRelease(proposed.candidate).resolution??0)<1080) {
        // No interactive decision is useful; normal bounded acquisition can
        // continue through later candidate pages without waiting on this tab.
        const updated=save(id,revision,{mode:'auto',phase:'consumed'});if(updated.state==='updated') wake(id);return updated;
      }
      const next=proposal.state==='proposal'?{mode:'auto',phase:'proposal',expiresMs:now()+300_000,
        proposal:{registered:proposal.registered,better:proposal.better,benefit:proposal.benefit}}:
        {mode:'auto',phase:'chosen',selection:proposal.selection};
      const updated=save(id,revision,next);if(updated.state==='updated') wake(id);
      return updated;
    } finally {inFlight.delete(id);}
  };
  const decide=(id,action,revision)=>{
    const current=snapshot(id);
    if(current.revision!==revision||current.phase!=='proposal'||!['better','registered'].includes(action)) return held('stale_release_selection');
    const updated=save(id,revision,{mode:'auto',phase:'chosen',selection:current.proposal[action]});
    if(updated.state==='updated') wake(id);return updated;
  };
  const setPreference=async(id,group,revision,audio)=>{
    if(group!==null&&!(await context(id)).confirmedAiring)return held('title_not_airing');
    const current=snapshot(id);
    if(current.revision!==revision)return held('stale_release_selection');
    const preference=group===null?null:makePreference(id,group,audio??current.preference?.audio??'japanese');
    if(group!==null&&!preference)return held('release_group_unavailable');
    const updated=requests.updateReleasePreference(id,revision,preference,now());
    if(updated.state==='updated')wake(id);return updated;
  };
  return {search,inspect,begin,choose,auto,decide,snapshot,context,setPreference};
}
