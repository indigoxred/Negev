import {DatabaseSync} from 'node:sqlite';
// Upgrade-time positive qualification for requested episodes that may have
// been represented only in the legacy direct/title caches. Uses the same
// public observer and guarded ledger as ordinary arrivals. Never acquires.
export async function warmRequestedAvailability({dbPath,observer,inventory,proofs,readCandidate,now=Date.now,maxTargets=1000,deadlineMs=15*60*1000}={}){
 if(typeof dbPath!=='string'||typeof observer?.observeTarget!=='function'||typeof inventory?.getFile!=='function'||typeof proofs?.observeGuarded!=='function'||typeof proofs?.getCurrent!=='function'||typeof readCandidate!=='function'||!Number.isSafeInteger(maxTargets)||maxTargets<1||maxTargets>10000||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>900000)throw new TypeError('Invalid requested cache qualification');
 const db=new DatabaseSync(dbPath,{readOnly:true,timeout:5000});let targets;
 try{
  if(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('requests','request_targets','targets')").get().n!==3)return{state:'checked',targets:0,recorded:0,alreadyAvailable:0,unconfirmed:0,pending:0};
  targets=db.prepare(`SELECT DISTINCT t.anidb_id anidbId,t.episode_id episodeId,r.kind FROM requests r JOIN request_targets rt ON rt.request_id=r.id JOIN targets t ON t.id=rt.target_id WHERE r.cancelled_ms IS NULL ORDER BY t.anidb_id,t.episode_id LIMIT ?`).all(maxTargets+1);
 }finally{db.close();}
 const started=now(),more=targets.length>maxTargets;targets=targets.slice(0,maxTargets);let next=0,recorded=0,alreadyAvailable=0,unconfirmed=0;const candidates=new Map();
 const getCandidate=fileId=>{if(!candidates.has(fileId))candidates.set(fileId,Promise.resolve().then(()=>readCandidate({fileId})).catch(()=>null));return candidates.get(fileId);};
 await Promise.all(Array.from({length:Math.min(2,targets.length)},async()=>{
  while(next<targets.length&&now()-started<deadlineMs){
   const target=targets[next++];
   if(proofs.getCurrent(target).state==='available'){alreadyAvailable++;continue;}
   let outcome;try{outcome=await observer.observeTarget(target,undefined,{includeProof:true});}catch{unconfirmed++;continue;}
   const proof=outcome?.proof;
   if(outcome?.state!=='available'||!outcome.cardRevision||!proof){unconfirmed++;continue;}
   const parts=proof.parts??[proof],sources=[];let valid=true;
   for(const part of parts){
    const candidate=await getCandidate(part.fileId),source=inventory.getFile(part.fileId);
    if(candidate?.state!=='candidate'||candidate.fileId!==part.fileId||source?.state!=='linked'||source.updated!==candidate.updated||!candidate.pairs?.some(p=>p.anidbId===target.anidbId&&p.episodeId===target.episodeId)){valid=false;break;}
    sources.push({fileId:part.fileId,updated:source.updated,observedMs:source.observedMs});
   }
   if(!valid||!sources.some(source=>source.fileId===proof.fileId)){unconfirmed++;continue;}
   const source=sources.find(s=>s.fileId===proof.fileId);
   const saved=proofs.observeGuarded({...target,proof,revision:{source:{updated:source.updated,observedMs:source.observedMs},card:outcome.cardRevision,...(proof.parts?{sources}:{})},checkedMs:now()});
   if(saved.state==='recorded'&&proofs.getCurrent(target).state==='available')recorded++;else unconfirmed++;
  }
 }));
 return{state:more||next<targets.length?'partial':'checked',targets:targets.length,recorded,alreadyAvailable,unconfirmed,pending:targets.length-next+(more?1:0)};
}
