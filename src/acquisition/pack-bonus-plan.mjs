import path from 'node:path';
import { torrentFileKind } from './evaluate-stopped-manifest.mjs';
import { isPackBonusVideo } from './pack-bonus-name.mjs';
export { isPackBonusVideo } from './pack-bonus-name.mjs';
import { acceptsShokoVideo } from './shoko-video-extensions.mjs';
import { evaluateOfflinePreview } from '../identity/evaluate-offline-preview.mjs';
import { collectAniDbDetail } from '../catalogue/collect-detail.mjs';

const validId = (id) => Number.isSafeInteger(id) && id > 0;

const NONREGULAR = new Set(['Special', 'Credit', 'Trailer', 'Parody', 'Other']);

function completeDetail(detail, anidbId) {
  return detail?.state === 'details' && detail.anidbId === anidbId &&
    detail.complete === true && detail.nextPage === null &&
    Number.isSafeInteger(detail.total) && Array.isArray(detail.episodes) &&
    detail.episodes.length === detail.total &&
    ['movie', 'series'].includes(detail.kind) && typeof detail.restricted === 'boolean' &&
    detail.episodes.every((episode) => validId(episode?.id) && validId(episode.number) &&
      typeof episode.type === 'string' && typeof episode.title === 'string') &&
    new Set(detail.episodes.map((episode) => episode.id)).size === detail.episodes.length;
}

function bonusKind(detail, episode, sameSeries) {
  if (episode.type !== 'Episode' && !NONREGULAR.has(episode.type)) return null;
  if (sameSeries) return NONREGULAR.has(episode.type)
    ? (episode.type === 'Special' ? 'special' : 'extra') : null;
  if (detail.kind === 'movie') return 'movie';
  const format = String(detail.format ?? detail.type ?? '').replace(/[ _-]/g, '').toLowerCase();
  if (['ova', 'oad'].includes(format)) return 'ova';
  if (format === 'tvspecial') return 'special';
  return null;
}

// Read-only enrichment. This is a filename prediction, never verification of
// downloaded bytes. Callers retain all original manifest/path safety gates.
export async function planPackBonuses({ request, detail, files, related,
  offlineLookup, loadDetail, readOwnership, allowRestricted = false,
  videoExtensions } = {}) {
  if (!Array.isArray(files)) throw new TypeError('Invalid pack files');
  const mainFiles = [], optional = [], bonusFiles = [], skippedBonuses = [];
  if (detail?.episodes?.some(e=>e.type!=='Episode' && request?.episodeIds?.includes(e.id))) {
    return { mainFiles: [...files], bonusFiles, skippedBonuses };
  }
  for (const file of files) {
    if (isPackBonusVideo(file?.name)) optional.push(file);
    else mainFiles.push(file);
  }
  const selectedTargets = new Set();
  let selectedBytes=mainFiles.filter(f=>torrentFileKind(f.name)==='video').reduce((sum,f)=>sum+f.size,0);
  const skip = (file, reason) => skippedBonuses.push({ name: file.name, size: file.size, reason });
  const deadline = Date.now() + 10_000;
  const expired = Symbol('deadline');
  let stopped = false;
  // Race each read against the remaining aggregate budget. Late reads cannot
  // mutate output, schedule further reads, or contribute identity evidence.
  async function read(callback) {
    const remaining = deadline - Date.now();
    if (stopped || remaining <= 0) { stopped = true; return expired; }
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(callback).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(expired), remaining); }),
      ]);
      if (value === expired || Date.now() >= deadline) { stopped = true; return expired; }
      return value;
    } finally { clearTimeout(timer); }
  }
  const details = new Map();
  if (validId(request?.anidbId)) details.set(request.anidbId, detail);
  async function ownDetail(anidbId) {
    if (details.has(anidbId)) return details.get(anidbId);
    const collected = await collectAniDbDetail({ anidbId, loadPage: async (args) => {
      const page = await read(() => loadDetail(args));
      return page;
    } });
    const result = collected;
    details.set(anidbId, result);
    return result;
  }
  for (const [index, file] of optional.entries()) {
    if (index >= 20) { skip(file, 'bonus_limit'); continue; }
    if (stopped || Date.now() >= deadline) { skip(file, 'bonus_deadline'); continue; }
    if (!validId(request?.anidbId) || typeof offlineLookup !== 'function') {
      skip(file, 'bonus_provider_unavailable'); continue;
    }
    if (!Number.isSafeInteger(file.size) || file.size < 1) {
      skip(file, 'invalid_bonus_file'); continue;
    }
    if (!acceptsShokoVideo(file.name, videoExtensions)) {
      skip(file, 'shoko_video_format_unsupported'); continue;
    }
    const filename = path.posix.basename(file.name);
    if (filename.length > 255) { skip(file, 'invalid_bonus_file'); continue; }
    const preview = await read(() => offlineLookup({ filename }));
    if (preview === expired) { skip(file, 'bonus_deadline'); continue; }
    const ref = preview?.release?.CrossReferences?.[0];
    const anidbId = ref?.AnidbAnimeID, episodeId = ref?.AnidbEpisodeID;
    if (!validId(anidbId) || !validId(episodeId) || evaluateOfflinePreview(preview, {
      animeId: anidbId, episodeIds: [episodeId], filename,
    }).state !== 'accepted') {
      skip(file, 'bonus_identity_unproven'); continue;
    }
    if(anidbId===request.anidbId&&request.episodeIds?.includes(episodeId)&&detail?.episodes?.some(e=>e.id===episodeId&&e.type==='Episode')){mainFiles.push(file);continue;}
    if(typeof loadDetail!=='function'||typeof readOwnership!=='function'){skip(file,'bonus_provider_unavailable');continue;}
    const targetKey=anidbId+':'+episodeId;
    if(selectedTargets.has(targetKey)){skip(file,'bonus_duplicate_target');continue;}
    const sameSeries = anidbId === request.anidbId;
    if (!sameSeries && (related?.state !== 'related_titles' ||
        related.anidbId !== request.anidbId || !Array.isArray(related.items) ||
        !related.items.some((item) => item?.anidbId === anidbId))) {
      skip(file, 'bonus_unrelated_identity'); continue;
    }
    const metadata = await ownDetail(anidbId);
    if (stopped) { skip(file, 'bonus_deadline'); continue; }
    if (!completeDetail(metadata, anidbId)) { skip(file, 'bonus_metadata_unavailable'); continue; }
    if (metadata.restricted && allowRestricted !== true) { skip(file, 'bonus_restricted'); continue; }
    const episode = metadata.episodes.find((item) => item.id === episodeId);
    const kind = episode && bonusKind(metadata, episode, sameSeries);
    if (!kind) { skip(file, 'bonus_type_unproven'); continue; }
    const ownership = await read(() => readOwnership({ anidbId, episodeId }));
    if (ownership === expired) { skip(file, 'bonus_deadline'); continue; }
    if (ownership?.state !== 'missing') { skip(file, 'bonus_ownership_unproven'); continue; }
    selectedTargets.add(targetKey);
    bonusFiles.push({ name: file.name, size: file.size, anidbId,
      episodeIds: [episodeId], kind, evidence: 'shoko_filename_prediction' });
  }
  // Main identity may have been recovered from a bonus-looking name above.
  // Allocate optional slots only after the complete main/subtitle set is known.
  let slots=Math.max(0,100-mainFiles.filter(f=>['video','subtitle'].includes(torrentFileKind(f.name))).length);
  selectedBytes=mainFiles.filter(f=>torrentFileKind(f.name)==='video').reduce((sum,f)=>sum+f.size,0);
  const bounded=[];
  for(const file of bonusFiles){
    if(slots===0){skip(file,'bonus_file_limit');continue;}
    if(!Number.isSafeInteger(selectedBytes+file.size)||selectedBytes+file.size>64*1024**3){skip(file,'bonus_byte_budget');continue;}
    bounded.push(file);slots--;selectedBytes+=file.size;
  }
  return { mainFiles, bonusFiles:bounded, skippedBonuses };
}




