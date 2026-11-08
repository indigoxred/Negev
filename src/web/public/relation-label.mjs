const labels = new Map([
  ['samesetting', 'Same setting'], ['alternativesetting', 'Alternative setting'],
  ['alternativeversion', 'Alternative version'], ['mainstory', 'Main story'],
  ['sidestory', 'Side story'], ['fullstory', 'Full story'],
]);

export function relationLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Related';
  const key = value.replace(/[_\s-]/g, '').toLowerCase();
  return labels.get(key) ?? value.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ').trim();
}
