import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import mediaInfoFactory from 'mediainfo.js';
import { evaluateMediaTracks } from './media-track-policy.mjs';

const MAX_CHUNK = 1024 * 1024;
const FAST_READ_PER_FILE = 4 * 1024 * 1024;
const MAX_READ_PER_FILE = 32 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function inspectEnglishSidecar(root, realRoot, videoName, subtitles) {
  const videoStem = path.parse(videoName).name.toLowerCase();
  const videoDir = path.dirname(videoName);
  const candidates = subtitles.filter((subtitle) => {
    const base = path.basename(subtitle.name).toLowerCase();
    const match = /^(.*)\.(?:en|eng|english)\.(?:srt|ass|ssa)$/.exec(base);
    return match && match[1] === videoStem &&
      path.dirname(subtitle.name) === videoDir;
  });
  if (candidates.length === 0) return subtitles.length > 0 ? 'uncertain' : 'absent';
  for (const candidate of candidates) {
    if (candidate.size > MAX_SUBTITLE_BYTES) return 'uncertain';
    const filePath = path.resolve(root, candidate.name);
    if (!within(root, filePath)) return 'uncertain';
    let handle;
    try {
      const [before, fileReal] = await Promise.all([
        lstat(filePath, { bigint: true }), realpath(filePath),
      ]);
      if (!before.isFile() || before.isSymbolicLink() ||
          before.size !== BigInt(candidate.size) ||
          !within(realRoot, fileReal)) return 'uncertain';
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const data = Buffer.alloc(candidate.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset,
          data.length - offset, offset);
        if (bytesRead < 1) return 'uncertain';
        offset += bytesRead;
      }
      const [after, afterReal] = await Promise.all([
        lstat(filePath, { bigint: true }), realpath(filePath),
      ]);
      if (!same(before, after) || afterReal !== fileReal) return 'uncertain';
      const text = data.toString('utf8');
      const srt = (text.match(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}/g) ?? []).length;
      const ass = (text.match(/^Dialogue:\s*\d+,/gm) ?? []).length;
      if (Math.max(srt, ass) >= 20 &&
          (text.match(/[A-Za-z]{3,}/g) ?? []).length >= 40) {
        return 'verified';
      }
    } catch { return 'uncertain'; }
    finally { await handle?.close(); }
  }
  return 'uncertain';
}

// MediaInfo reads selected chunks, never the whole video. The real path,
// physical identity, size and mtime are checked both before and after.
export async function inspectStagedMediaTracks({ stagingRoot, files, subtitles = [],
  createAnalyzer = () => mediaInfoFactory({ format: 'object',
    chunkSize: 128 * 1024, full: false }) } = {}) {
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot) ||
      !Array.isArray(files) || files.length < 1 || files.length > 50 ||
      !Array.isArray(subtitles) || subtitles.length > 50 ||
      files.some((file) => typeof file?.name !== 'string' ||
        !file.name || path.isAbsolute(file.name) ||
        !Number.isSafeInteger(file.size) || file.size < 1) ||
      subtitles.some((file) => typeof file?.name !== 'string' ||
        !file.name || path.isAbsolute(file.name) ||
        !Number.isSafeInteger(file.size) || file.size < 1) ||
      typeof createAnalyzer !== 'function') {
    throw new TypeError('Invalid staged media track inspection');
  }
  let rootReal;
  try { rootReal = await realpath(stagingRoot); }
  catch { return { state: 'unverified', reason: 'staging_unavailable' }; }
  const inspected = [];
  for (const file of files) {
    const filePath = path.resolve(stagingRoot, file.name);
    if (!within(stagingRoot, filePath)) {
      return { state: 'unverified', reason: 'unsafe_staging_path' };
    }
    let before, fileReal, handle;
    try {
      [before, fileReal] = await Promise.all([
        lstat(filePath, { bigint: true }), realpath(filePath),
      ]);
      if (!before.isFile() || before.isSymbolicLink() ||
          before.size !== BigInt(file.size) ||
          !within(rootReal, fileReal)) {
        return { state: 'unverified', reason: 'staged_file_changed' };
      }
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let verdict, resultTracks;
      let incompleteRead = false;
      for (const limit of [FAST_READ_PER_FILE, MAX_READ_PER_FILE]) {
        let readBytes = 0;
        let capped = false;
        const analyzer = await createAnalyzer();
        try {
          const result = await analyzer.analyzeData(file.size, async (size, offset) => {
            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CHUNK ||
                !Number.isSafeInteger(offset) || offset < 0) {
              throw new Error('Invalid MediaInfo read request');
            }
            if (readBytes + size > limit) {
              capped = true;
              return new Uint8Array(0);
            }
            const chunk = new Uint8Array(size);
            const { bytesRead } = await handle.read(chunk, 0, size, offset);
            readBytes += bytesRead;
            return chunk.subarray(0, bytesRead);
          });
          resultTracks = result?.media?.track;
          verdict = evaluateMediaTracks(resultTracks);
        } finally { analyzer.close(); }
        incompleteRead = capped;
        if (verdict.state === 'accepted' || !capped) break;
      }
      const [after, afterReal] = await Promise.all([
        lstat(filePath, { bigint: true }), realpath(filePath),
      ]);
      if (!same(before, after) || afterReal !== fileReal) {
        return { state: 'unverified', reason: 'staged_file_changed' };
      }
      if (verdict.state !== 'accepted') {
        const sidecar = await inspectEnglishSidecar(stagingRoot, rootReal,
          file.name, subtitles);
        if (sidecar === 'verified') {
          verdict = evaluateMediaTracks(resultTracks,
            { externalEnglishSubtitle: true });
        } else if (sidecar === 'uncertain') {
          return { state: 'unverified', reason: 'subtitle_coverage_unverified' };
        }
      }
      if (incompleteRead && verdict.state !== 'accepted') {
        return { state: 'unverified', reason: 'media_read_budget_exhausted' };
      }
      if (verdict.state !== 'accepted') return verdict;
      inspected.push({ name: file.name, audio: verdict.audio,
        resolution: verdict.resolution });
    } catch {
      return { state: 'unverified', reason: 'tracks_unavailable' };
    } finally {
      await handle?.close();
    }
  }
  return { state: 'accepted', files: inspected };
}
