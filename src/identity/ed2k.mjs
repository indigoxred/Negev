import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

export const ED2K_CHUNK_SIZE = 9_728_000;

const rotate = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;
const f = (b, c, d) => (b & c) | (~b & d);
const g = (b, c, d) => (b & c) | (b & d) | (c & d);
const h = (b, c, d) => b ^ c ^ d;

function* md4Steps(input) {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const data = Buffer.alloc(paddedLength);
  input.copy(data);
  data[input.length] = 0x80;
  data.writeBigUInt64LE(BigInt(input.length) * 8n, paddedLength - 8);

  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  const words = new Uint32Array(16);
  const rounds = [
    { indexes: [...Array(16).keys()], shifts: [3, 7, 11, 19], mix: f, constant: 0 },
    { indexes: [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15], shifts: [3, 5, 9, 13], mix: g, constant: 0x5a827999 },
    { indexes: [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15], shifts: [3, 9, 11, 15], mix: h, constant: 0x6ed9eba1 },
  ];

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = data.readUInt32LE(offset + i * 4);
    const original = [...state];
    for (const round of rounds) {
      for (let i = 0; i < 16; i++) {
        const target = [0, 3, 2, 1][i % 4];
        const b = state[(target + 1) % 4];
        const c = state[(target + 2) % 4];
        const d = state[(target + 3) % 4];
        state[target] = rotate(
          (state[target] + round.mix(b, c, d) + words[round.indexes[i]] + round.constant) >>> 0,
          round.shifts[i % 4],
        );
      }
    }
    for (let i = 0; i < 4; i++) state[i] = (state[i] + original[i]) >>> 0;
    if ((offset + 64) % (1024 * 1024) === 0 && offset + 64 < data.length) yield;
  }

  const digest = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) digest.writeUInt32LE(state[i], i * 4);
  return digest;
}

function md4(input) {
  const steps = md4Steps(input);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

async function md4Cooperative(input, yieldCpu) {
  const steps = md4Steps(input);
  let result = steps.next();
  while (!result.done) {
    await yieldCpu();
    result = steps.next();
  }
  return result.value;
}

function ed2kFromChunkDigests(digests) {
  if (digests.length === 0) throw new Error('Cannot identify an empty video file');
  const digest = digests.length === 1 ? digests[0] : md4(Buffer.concat(digests));
  return digest.toString('hex').toUpperCase();
}

export function ed2kBuffer(bytes) {
  if (bytes.length === 0) throw new Error('Cannot identify an empty video file');
  const digests = [];
  for (let offset = 0; offset < bytes.length; offset += ED2K_CHUNK_SIZE) {
    digests.push(md4(bytes.subarray(offset, offset + ED2K_CHUNK_SIZE)));
  }
  return ed2kFromChunkDigests(digests);
}

export async function ed2kFile(path, { pacer, expectedStat,
  yieldCpu = () => setImmediate() } = {}) {
  if (pacer !== undefined && typeof pacer?.afterBytes !== 'function') {
    throw new TypeError('Invalid ED2K read pacer');
  }
  if (typeof yieldCpu !== 'function') throw new TypeError('Invalid ED2K CPU yield');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (expectedStat &&
        (before.dev !== expectedStat.dev || before.ino !== expectedStat.ino ||
          before.size !== expectedStat.size ||
          before.mtimeNs !== expectedStat.mtimeNs ||
          before.ctimeNs !== expectedStat.ctimeNs))) {
      throw new Error('File changed before hashing');
    }
    if (before.size === 0n) throw new Error('Cannot identify an empty video file');
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('File size is not safe to represent');
    const chunk = Buffer.alloc(ED2K_CHUNK_SIZE);
    const digests = [];
    let remaining = before.size;
    while (remaining > 0n) {
      const wanted = Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length));
      let filled = 0;
      while (filled < wanted) {
        const { bytesRead } = await file.read(chunk, filled, wanted - filled);
        if (bytesRead === 0) throw new Error('File ended during hashing');
        filled += bytesRead;
      }
      digests.push(await md4Cooperative(chunk.subarray(0, wanted), yieldCpu));
      remaining -= BigInt(wanted);
      if (pacer) await pacer.afterBytes(wanted);
      else await setImmediate();
    }
    const after = await file.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs) {
      throw new Error('File changed during hashing');
    }
    return { ed2k: ed2kFromChunkDigests(digests), size: Number(before.size) };
  } finally {
    await file.close();
  }
}
