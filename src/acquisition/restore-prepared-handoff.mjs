import path from 'node:path';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });

// Recover a claim from the durable journal after a restart. The publisher
// still rechecks the private tree, every video's bytes, and every subtitle.
export function restorePreparedHandoff({ attemptId, handoff } = {}) {
  if (!Number.isSafeInteger(attemptId) || attemptId < 1 ||
      !['prepared', 'publish_unknown', 'published_observed'].includes(handoff?.status) ||
      typeof handoff.holdingPath !== 'string' ||
      !path.isAbsolute(handoff.holdingPath) ||
      typeof handoff.torrentHash !== 'string' ||
      typeof handoff.evidenceDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(handoff.evidenceDigest)) {
    return held('handoff_evidence_mismatch');
  }
  const manifest = handoff.manifest;
  const evidence = evaluateHandoffEvidence({
    identity: manifest?.identity, version: manifest?.version,
    anidbId: manifest?.anidbId, torrentHash: manifest?.torrentHash,
    files: manifest?.videos, subtitles: manifest?.subtitles,
  });
  if (evidence.state !== 'valid' ||
      (manifest?.identity === 'provisional' &&
        manifest.videos.some((file) => file.episodeIds.length !== 1)) ||
      JSON.stringify(manifest) !== JSON.stringify(evidence.manifest) ||
      evidence.digest !== handoff.evidenceDigest ||
      evidence.manifest.torrentHash !== handoff.torrentHash ||
      handoff.publishName !==
        `negev-${attemptId}-${evidence.digest.slice(0, 16)}`) {
    return held('handoff_evidence_mismatch');
  }
  return { state: 'handoff_prepared', publishReady: false,
    holdingPath: handoff.holdingPath,
    torrentHash: evidence.manifest.torrentHash,
    anidbId: evidence.manifest.anidbId,
    ...(evidence.manifest.identity === 'provisional'
      ? { identity: 'provisional' } : {}),
    evidenceDigest: evidence.digest,
    files: evidence.manifest.videos,
    subtitles: evidence.manifest.subtitles };
}
