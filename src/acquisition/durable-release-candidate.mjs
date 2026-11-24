import { createHash } from 'node:crypto';
// Durable release locators contain no provider authentication. Keep the source
// origin/path so legacy untrusted URLs cannot acquire trust during migration.
export function proxyDescriptor(value, indexerId) {
 if(!Number.isSafeInteger(indexerId)||indexerId<1)return null;
 let url; try { url=new URL(value); } catch { return null; }
 const keys=[...url.searchParams.keys()];
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||
   !new RegExp(`^/(?:[A-Za-z0-9_-]+/)*${indexerId}/download$`).test(url.pathname)||
   ![2,3].includes(keys.length)||!keys.includes('link')||!keys.includes('file')||new Set(keys).size!==keys.length||!keys.every(k=>['apikey','link','file'].includes(k))||
   !/^[A-Za-z0-9_-]{1,4096}$/.test(url.searchParams.get('link')??'')||
   !(url.searchParams.get('file')?.length>0)||url.searchParams.get('file').length>500) return null;
 return {version:1,origin:url.origin,pathname:url.pathname,link:url.searchParams.get('link'),file:url.searchParams.get('file')};
}
export function durableCandidate(candidate) {
 if(!candidate||typeof candidate!=='object')return candidate;
 const {proxyUrl,...original}=candidate;
 const guidDescriptor=proxyDescriptor(candidate.guid,candidate.indexerId);
 const rest={...original,guid:canonicalReleaseGuid(candidate.guid,candidate.indexerId)};
 if(proxyUrl===undefined)return guidDescriptor?{...rest,proxyDescriptor:candidate.proxyDescriptor??guidDescriptor}:rest.guid!==candidate.guid?{...rest,proxyDescriptor:{version:0}}:rest;
 const descriptor=proxyDescriptor(proxyUrl,candidate.indexerId);
 return {...rest,...(descriptor?{proxyDescriptor:descriptor}:{proxyDescriptor:{version:0}})};
}
export function durableSelection(selection) {
 return selection?{...selection,candidate:durableCandidate(selection.candidate)}:selection;
}
export function durableControl(control) {
 return {...control,...(control.selection?{selection:durableSelection(control.selection)}:{}),
  ...(control.proposal?{proposal:{...control.proposal,registered:durableSelection(control.proposal.registered),better:durableSelection(control.proposal.better)}}:{})};
}
export function resolveProxyDescriptor(descriptor,base,apiKey,indexerId) {
 if(descriptor?.version!==1||descriptor.origin!==base.origin||
   descriptor.pathname!==`${base.pathname==='/'?'':base.pathname.slice(0,-1)}/${indexerId}/download`||
   !/^[A-Za-z0-9_-]{1,4096}$/.test(descriptor.link??'')||typeof descriptor.file!=='string'||
   !descriptor.file.length||descriptor.file.length>500)return null;
 const url=new URL(descriptor.pathname,base);
 url.search=new URLSearchParams({apikey:apiKey,link:descriptor.link,file:descriptor.file}).toString();
 return url.href;
}

export function canonicalReleaseGuid(guid,indexerId) {
 const descriptor=proxyDescriptor(guid,indexerId);
 if(!descriptor) {
  let url;try{url=new URL(guid);}catch{return guid;}
  return url.username||url.password||[...url.searchParams.keys()].some(k=>k.toLowerCase()==='apikey')
   ? 'unusable-release:'+createHash('sha256').update(guid).digest('hex'):guid;
 }
 const url=new URL(descriptor.pathname,descriptor.origin);
 url.search=new URLSearchParams({link:descriptor.link,file:descriptor.file}).toString();
 return url.href;
}
const digest=value=>createHash('sha256').update(value).digest('hex');
// Save only digests, before removing a legacy credential from the saved choice.
// This retains historical attempts without storing or reconstructing old keys.
export function rememberLegacyCandidate(db,candidate) {
 if(!candidate||typeof candidate.guid!=='string')return;
 const canonical=canonicalReleaseGuid(candidate.guid,candidate.indexerId);
 if(canonical===candidate.guid)return;
 db.exec(`CREATE TABLE IF NOT EXISTS acquisition_candidate_aliases (
  indexer_id INTEGER NOT NULL,canonical_digest TEXT NOT NULL,legacy_digest TEXT NOT NULL,
  PRIMARY KEY(indexer_id,canonical_digest,legacy_digest)) STRICT`);
 const save=db.prepare('INSERT OR IGNORE INTO acquisition_candidate_aliases VALUES(?,?,?)');
 save.run(candidate.indexerId,digest(canonical),digest(candidate.guid));
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='acquisition_attempts'").get()) {
  for(const row of db.prepare('SELECT DISTINCT anidb_id FROM acquisition_attempts WHERE indexer_id=?').all(candidate.indexerId)) {
   for(const prefix of ['release-policy-reset-v1','wrong-installment-reassignment-v1'])
    save.run(candidate.indexerId,digest(JSON.stringify([prefix,row.anidb_id,canonical])),digest(JSON.stringify([prefix,row.anidb_id,candidate.guid])));
  }
 }
}
export function rememberLegacySelection(db,selection) { rememberLegacyCandidate(db,selection?.candidate); }
export function rememberLegacyControl(db,control) {
 rememberLegacySelection(db,control?.selection);
 rememberLegacySelection(db,control?.proposal?.registered);
 rememberLegacySelection(db,control?.proposal?.better);
}
