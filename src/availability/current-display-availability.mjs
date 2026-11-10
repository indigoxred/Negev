export function currentDisplayAvailability({ live, file, hasShokoFile }) {
  if (live?.state === 'available') return live;
  if (hasShokoFile && file?.state === 'available') {
    return {
      state: 'available',
      ...(file.presentation === 'alternate_card'
        ? { presentation: 'alternate_card' } : {}),
    };
  }
  return live ?? { state: 'unknown' };
}
