// Older control-flow fixtures promised the matching file with a scalar ID.
// Model that promise as a physical public witness. Real observer results and
// deliberately supplied proofs pass through unchanged.
export function withRescanPublicProof(options) {
  if (typeof options.verifyPlex !== 'function') return options;
  return { ...options, verifyPlex: async input => {
    const result = await options.verifyPlex(input);
    if (result?.state !== 'available' || result.proof !== undefined || result.multipart) return result;
    const file = options.item.manifest.files.find(file => file.episodeIds?.includes(input.episodeId));
    return { ...result, proof: { fileId: result.fileId,
      storageKey: `${file.dev}:${file.ino}:${file.size}` } };
  } };
}
