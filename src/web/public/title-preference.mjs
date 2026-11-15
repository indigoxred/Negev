export function detailOriginalTitle(item, detail) {
  const original = detail?.originalTitle?.trim();
  if (original) return original;
  const cardTitle = item?.title?.trim();
  if (cardTitle && !/^Anime \d+$/.test(cardTitle)) return cardTitle;
  return detail?.title?.trim() || cardTitle || '';
}
