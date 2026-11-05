export function episodeDisplayAvailability({ direct, title, file } = {}) {
  if (direct === 'available' || title === 'available') {
    return { availability: 'available' };
  }
  if (file?.state === 'available') {
    return { availability: 'available',
      ...(file.presentation === 'alternate_card'
        ? { availabilityNote: 'alternate_card' } : {}) };
  }
  return { availability: title === 'previously_available' ||
    file?.state === 'previously_available'
    ? 'previously_available' : 'unknown' };
}
