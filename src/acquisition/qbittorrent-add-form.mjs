import { matchesStagingSavePath } from './staging-save-path.mjs';

// Build only. No network call or torrent start is made here. A later caller
// must reserve the attempt durably and reconcile an uncertain add response.
export function buildStoppedTorrentAddForm({ torrentBytes, savePath, category }) {
  if (!(torrentBytes instanceof Uint8Array) ||
      torrentBytes.byteLength < 1 || torrentBytes.byteLength > 2_000_000 ||
      !matchesStagingSavePath({ hash: savePath?.slice('/Downloads/negev/'.length), savePath }) ||
      category !== 'negev') {
    throw new TypeError('Invalid isolated torrent-add input');
  }
  const form = new FormData();
  form.set('torrents', new Blob([torrentBytes], { type: 'application/x-bittorrent' }), 'candidate.torrent');
  form.set('savepath', savePath);
  form.set('category', category);
  form.set('stopped', 'true');
  form.set('autoTMM', 'false');
  form.set('skip_checking', 'false');
  form.set('contentLayout', 'NoSubfolder');
  return form;
}
