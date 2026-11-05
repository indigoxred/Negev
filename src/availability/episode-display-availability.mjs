export function episodeDisplayAvailability({ direct, directPresentation,
  title, file } = {}) {
  if (direct === 'available' || title === 'available') {
    return { availability: 'available',
      ...(direct === 'available' && directPresentation === 'alternate_card'
        ? { availabilityNote: 'alternate_card' } : {}) };
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
