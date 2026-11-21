import { regularEpisodeSchedule } from './public/episode-schedule.mjs';
// A cache-only presentation projection. No provider calls, scans, hydration,
// acquisition policy or new persistent state.
export function cachedRegularCoverage({index,verifiedIds,asOf}) {
  if(!Array.isArray(index?.regularEpisodes)||!index.regularEpisodes.length||!Array.isArray(index.regularIds)||index.regularIds.length!==index.regularEpisodes.length||new Set(index.regularIds).size!==index.regularIds.length)return undefined;
  const episodes=index.regularEpisodes,ids=new Set(index.regularIds);
  if(episodes.length>10000||new Set(episodes.map(e=>e.id)).size!==episodes.length)return undefined;
  if(episodes.some(e=>e.type!=='Episode'||!Number.isSafeInteger(e.id)||!ids.has(e.id)))return undefined;
  const schedule=regularEpisodeSchedule({episodes,asOf,verifiedIds});
  if(!schedule)return undefined;
  const specials=index.specialEpisodes;
  const separate=Array.isArray(specials)&&specials.length<=10000&&specials.every(e=>e.type==='Special'&&Number.isSafeInteger(e.id))&&new Set(specials.map(e=>e.id)).size===specials.length
    ?{specialTotal:specials.length,specialVerified:specials.filter(e=>verifiedIds.has(e.id)).length}:{};
  return {...separate,...(['series','movie'].includes(index.kind)?{kind:index.kind}:{}),total:episodes.length,verified:episodes.filter(e=>verifiedIds.has(e.id)).length,aired:schedule.aired,verifiedAired:schedule.verifiedAired,upcoming:schedule.upcoming,undated:schedule.undated};
}
