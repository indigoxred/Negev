// Bonus absence is deliberately stricter than main-request first-time policy.
export function createBonusOwnershipReader({readEpisode}={}) {
 if(typeof readEpisode!=='function')throw new TypeError('Invalid bonus ownership reader');
 return async({anidbId,episodeId})=>{
  if(![anidbId,episodeId].every(v=>Number.isSafeInteger(v)&&v>0))return {state:'uncertain'};
  let result;try{result=await readEpisode({anidbId,episodeId})}catch{return {state:'uncertain'}}
  if(['not_imported','empty_episode'].includes(result?.state)&&result.anidbId===anidbId&&result.episodeId===episodeId)return {state:'missing'};
  return {state:result?.state==='ok'&&Array.isArray(result.files)&&result.files.length>0?'owned':'uncertain'};
 };
}

// One aggregate deadline: optional provider work must never pin main dispatch.
export async function refreshBonusOwnership({files,readOwnership,budgetMs=10000}) {
 if(!Array.isArray(files)||files.length>20||!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>10000)throw new TypeError('Invalid bonus refresh');
 const selected=[],skipped=[],deadline=Date.now()+budgetMs,expired=Symbol('expired');let exhausted=false;
 for(const file of files){
  if(exhausted||typeof readOwnership!=='function'){skipped.push(file);continue;}
  const remaining=deadline-Date.now();if(remaining<=0){exhausted=true;skipped.push(file);continue;}
  let timer,result;try{result=await Promise.race([Promise.resolve().then(()=>readOwnership({anidbId:file.anidbId,episodeId:file.episodeIds[0]})).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),remaining)})]);}finally{clearTimeout(timer)}
  if(result===expired||Date.now()>=deadline){exhausted=true;skipped.push(file);}else if(result?.state==='missing')selected.push(file);else skipped.push(file);
 }
 return {files:selected,skipped};
}
