import path from 'node:path';
import { evaluateHandoffEvidence } from './handoff-evidence.mjs';

const held = (reason) => ({ state: 'held', reason });

// Recover the input to the existing publisher from the durable journal after
// a restart. This recreates a claim only; the publisher must still recheck the
// private tree, every video against AniDB, and every subtitle before a rename.
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
    anidbId: manifest?.anidbId, torrentHash: manifest?.torrentHash,
    files: manifest?.videos, subtitles: manifest?.subtitles,
  });
  if (evidence.state !== 'valid' ||
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
    evidenceDigest: evidence.digest,
    files: evidence.manifest.videos,
    subtitles: evidence.manifest.subtitles };
}
