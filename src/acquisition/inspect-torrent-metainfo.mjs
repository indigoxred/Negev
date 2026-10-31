import { createHash } from 'node:crypto';

const held = (reason) => ({ state: 'held', reason });
const keyOf = (name) => Buffer.from(name).toString('hex');
const field = (dict, name) => dict?.kind === 'dict' ? dict.value.get(keyOf(name)) : undefined;
const asBytes = (node) => node?.kind === 'bytes' ? node.value : null;
const asInt = (node) => node?.kind === 'int' && Number.isSafeInteger(node.value) ? node.value : null;
const decoder = new TextDecoder('utf-8', { fatal: true });

function parseBencode(bytes) {
  let offset = 0;
  let nodes = 0;
  const invalid = () => { throw new TypeError('Invalid canonical bencode'); };
  function parse(depth) {
    if (depth > 32 || ++nodes > 10_000 || offset >= bytes.length) invalid();
    const start = offset;
    const token = bytes[offset++];
    if (token === 105) {
      const end = bytes.indexOf(101, offset);
      if (end < 0 || end - offset > 18) invalid();
      for (let i = offset; i < end; i++) {
        if ((bytes[i] < 48 || bytes[i] > 57) && !(i === offset && bytes[i] === 45)) invalid();
      }
      const literal = Buffer.from(bytes.subarray(offset, end)).toString('ascii');
      if (!/^(?:0|-?[1-9][0-9]*)$/.test(literal)) invalid();
      const value = Number(literal);
      if (!Number.isSafeInteger(value)) invalid();
      offset = end + 1;
      return { kind: 'int', value, start, end: offset };
    }
    if (token === 108 || token === 100) {
      const isDict = token === 100;
      const value = isDict ? new Map() : [];
      let previous = null;
      while (offset < bytes.length && bytes[offset] !== 101) {
        if (isDict) {
          const key = parse(depth + 1);
          if (key.kind !== 'bytes' || (previous && Buffer.compare(previous, key.value) >= 0)) invalid();
          previous = key.value;
          value.set(key.value.toString('hex'), parse(depth + 1));
        } else value.push(parse(depth + 1));
      }
      if (offset >= bytes.length) invalid();
      offset++;
      return { kind: isDict ? 'dict' : 'list', value, start, end: offset };
    }
    if (token < 48 || token > 57) invalid();
    let digits = String.fromCharCode(token);
    while (offset < bytes.length && bytes[offset] !== 58) {
      const next = bytes[offset++];
      if (next < 48 || next > 57 || digits.length > 7) invalid();
      digits += String.fromCharCode(next);
    }
    if (offset >= bytes.length || (digits.length > 1 && digits[0] === '0')) invalid();
    offset++;
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || length > bytes.length - offset) invalid();
    const value = Buffer.from(bytes.subarray(offset, offset + length));
    offset += length;
    return { kind: 'bytes', value, start, end: offset };
  }
  const root = parse(0);
  if (offset !== bytes.length || root.kind !== 'dict') invalid();
  return root;
}

function safeSegment(node) {
  const bytes = asBytes(node);
  if (!bytes || bytes.length < 1 || bytes.length > 255) throw new TypeError('Unsafe torrent path');
  const value = decoder.decode(bytes);
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\') ||
      /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
      value.endsWith('.') || value.endsWith(' ')) throw new TypeError('Unsafe torrent path');
  return value;
}

function addFile(files, name, size) {
  if (!Number.isSafeInteger(size) || size < 1 || files.length >= 500 ||
      files.some((file) => file.name.toLowerCase() === name.toLowerCase())) {
    throw new TypeError('Invalid torrent file list');
  }
  files.push({ name, size });
}

function v1Files(info) {
  const single = field(info, 'length');
  const list = field(info, 'files');
  if (!!single === !!list) throw new TypeError('Invalid v1 file view');
  const name = safeSegment(field(info, 'name'));
  const files = [];
  let pieceBytes = 0;
  if (single) {
    const size = asInt(single);
    addFile(files, name, size);
    pieceBytes = size;
  } else {
    if (list.kind !== 'list' || list.value.length < 1 || list.value.length > 500) {
      throw new TypeError('Invalid v1 files');
    }
    for (const entry of list.value) {
      const size = asInt(field(entry, 'length'));
      const path = field(entry, 'path');
      if (entry.kind !== 'dict' || path?.kind !== 'list' ||
          path.value.length < 1 || path.value.length > 20 ||
          !Number.isSafeInteger(size) || size < 1) throw new TypeError('Invalid v1 file');
      pieceBytes += size;
      const fileName = path.value.map(safeSegment).join('/');
      const attr = asBytes(field(entry, 'attr'));
      if (attr && attr.includes(112)) {
        if (attr.toString('ascii') !== 'p' || !/^\.pad\/[1-9][0-9]*$/.test(fileName) ||
            Number(fileName.slice(5)) !== size) {
          throw new TypeError('Invalid padding file');
        }
        continue;
      }
      addFile(files, fileName, size);
    }
  }
  if (!Number.isSafeInteger(pieceBytes) || files.length < 1) throw new TypeError('Invalid v1 size');
  return { files, pieceBytes };
}

function v2Files(info) {
  const tree = field(info, 'file tree');
  if (tree?.kind !== 'dict' || tree.value.size < 1) throw new TypeError('Invalid v2 file tree');
  const files = [];
  function walk(node, prefix, depth) {
    if (depth > 20 || node.kind !== 'dict') throw new TypeError('Invalid v2 tree');
    const leaf = field(node, '');
    if (leaf) {
      if (prefix.length === 0 || node.value.size !== 1 || leaf.kind !== 'dict') {
        throw new TypeError('Invalid v2 leaf');
      }
      const size = asInt(field(leaf, 'length'));
      const root = asBytes(field(leaf, 'pieces root'));
      if (!root || root.length !== 32) throw new TypeError('Invalid v2 piece root');
      addFile(files, prefix.join('/'), size);
      return;
    }
    for (const [rawKey, child] of node.value) {
      const segment = safeSegment({ kind: 'bytes', value: Buffer.from(rawKey, 'hex') });
      walk(child, [...prefix, segment], depth + 1);
    }
  }
  walk(tree, [], 0);
  if (files.length < 1) throw new TypeError('Empty v2 file tree');
  return files;
}

// Structural preflight only. qBittorrent must still validate torrent piece
// hashes and v2 Merkle layers; Shoko must later verify the actual video ED2K.
export function inspectTorrentMetainfo({ bytes }) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > 2_000_000) {
    return held('invalid_metainfo');
  }
  try {
    const root = parseBencode(bytes);
    const info = field(root, 'info');
    if (info?.kind !== 'dict') return held('invalid_metainfo');
    const versionNode = field(info, 'meta version');
    const isV2 = versionNode !== undefined;
    if (isV2 && asInt(versionNode) !== 2) return held('unsupported_torrent_version');
    const pieceLength = asInt(field(info, 'piece length'));
    if (!pieceLength || pieceLength < 1 || pieceLength > 134_217_728 ||
        (isV2 && (pieceLength < 16_384 || !Number.isInteger(Math.log2(pieceLength))))) {
      return held('invalid_metainfo');
    }
    const pieces = asBytes(field(info, 'pieces'));
    const hasV1 = pieces !== null;
    if (!isV2 && !hasV1) return held('invalid_metainfo');
    let oldView;
    if (hasV1) {
      oldView = v1Files(info);
      if (pieces.length < 20 || pieces.length % 20 !== 0 ||
          pieces.length / 20 !== Math.ceil(oldView.pieceBytes / pieceLength)) {
        return held('invalid_piece_list');
      }
    } else if (field(info, 'length') || field(info, 'files')) return held('conflicting_file_views');
    let files;
    if (isV2) {
      if (field(root, 'piece layers')?.kind !== 'dict') return held('invalid_metainfo');
      files = v2Files(info);
      if (oldView) {
        const sorted = (items) => items.map(({ name, size }) => `${name}\0${size}`).sort();
        if (JSON.stringify(sorted(files)) !== JSON.stringify(sorted(oldView.files))) {
          return held('conflicting_file_views');
        }
      }
    } else files = oldView.files;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1) return held('invalid_metainfo');
    const rawInfo = bytes.subarray(info.start, info.end);
    const hash = isV2 ? createHash('sha256').update(rawInfo).digest('hex').slice(0, 40)
      : createHash('sha1').update(rawInfo).digest('hex');
    return { state: 'metainfo_checked', version: isV2 ? (hasV1 ? 'hybrid' : 'v2') : 'v1',
      hash, totalBytes, files };
  } catch (error) {
    return held(error instanceof TypeError && error.message === 'Unsafe torrent path'
      ? 'unsafe_file_path' : 'invalid_metainfo');
  }
}
