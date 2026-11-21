// Presentation only: never turn an aggregate item count (which may include
// Specials) into a regular-episode coverage claim.
export function validRegularCoverage(value) {
  if(!value||!['total','verified','aired','verifiedAired','upcoming','undated'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=10000))return false;
  if(value.specialTotal!==undefined||value.specialVerified!==undefined){if(!Number.isSafeInteger(value.specialTotal)||!Number.isSafeInteger(value.specialVerified)||value.specialTotal<0||value.specialTotal>10000||value.specialVerified<0||value.specialVerified>value.specialTotal)return false;}
  return value.total>0&&value.verified<=value.total&&value.verifiedAired<=value.aired&&value.verifiedAired<=value.verified&&value.aired+value.upcoming+value.undated===value.total;
}
export function catalogueAvailability(presence, releaseStatus='', kind=null) {
  if(!presence||presence.state!=='in_library')return null;
  const coverage=presence.regularCoverage;
  if(!validRegularCoverage(coverage))return {text:'In library · coverage unconfirmed',state:'unknown'};
  const {total,verified,aired,verifiedAired,upcoming}=coverage;
  const specialText=coverage.specialTotal>0?(coverage.specialVerified>0?`${coverage.specialVerified}/${coverage.specialTotal} Special${coverage.specialTotal===1?'':'s'} available`:'Specials unconfirmed'):null;
  const enrich=result=>({...result,...(specialText?{specialText,specialState:coverage.specialVerified===coverage.specialTotal?'available':coverage.specialVerified>0?'partial':'unknown'}:{})});
  const ongoing=['ongoing','airing','releasing','currentlyairing'].includes(String(releaseStatus).replace(/[^a-z]/gi,'').toLowerCase());
  if((ongoing||upcoming>0)&&aired>0){
    return enrich(verifiedAired===aired?{text:`All ${aired} aired episodes available`,state:'available'}:
      verifiedAired>0?{text:`Partial · ${verifiedAired}/${aired} aired available`,state:'partial'}:
        {text:'Aired availability unconfirmed',state:'unknown'});
  }
  const units=(coverage.kind??kind)==='movie'?'film'+(total===1?'':'s'):'episodes';
  return enrich(verified===total?{text:`${verified}/${total} ${units} available`,state:'available'}:
    verified>0?{text:`Partial · ${verified}/${total} ${units}`,state:'partial'}:
      {text:'Regular episodes unconfirmed',state:'unknown'});
}
