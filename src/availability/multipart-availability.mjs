// Only ordered, physically witnessed Parts of one Plex Media combine; versions never do.
export function combinedMultipartProof({ target, files, provenParts }) {
  const groups = new Map();
  for (const part of provenParts) {
    if (!Number.isSafeInteger(part.mediaId) || part.mediaId < 1 || !Number.isSafeInteger(part.ratingKey) || part.ratingKey < 1 || !Number.isSafeInteger(part.partIndex) || part.partIndex < 0 || !Number.isSafeInteger(part.partCount) || part.partCount < 2 || part.partCount > 8) continue;
    const key = [part.libraryId, part.ratingKey, part.mediaId].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(part);
  }
  for (const parts of groups.values()) {
    parts.sort((a,b) => a.partIndex-b.partIndex);
    const count = parts[0].partCount;
    if (parts.length !== count || parts.some((p,i) => p.partCount !== count || p.partIndex !== i) || ['partId','fileId','storageKey'].some(key => new Set(parts.map(p=>p[key])).size !== count)) continue;
    let end = 0, valid = true;
    for (const part of parts) {
      const matches = files.filter(f => f.fileId === part.fileId && f.storageKey === part.storageKey && f.anidbId === target.anidbId);
      const signatures = new Set(matches.map(f => JSON.stringify(f.coverage)));
      const range = matches[0]?.coverage?.find(r=>r.episodeId === target.episodeId);
      if (signatures.size !== 1 || !range || range.start !== end || !Number.isFinite(range.end) || range.end <= end || range.end > 100) { valid = false; break; }
      end = range.end;
    }
    if (valid && end === 100) return { state:'available', fileId:parts[0].fileId, fileIds:parts.map(p=>p.fileId), multipart:true, proof:{...parts[0],parts} };
  }
  return null;
}
