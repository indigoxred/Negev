// Keep a pending metadata refresh well below the signed-in title-read budget.
export function detailRefreshDelay(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new TypeError('Invalid refresh attempt');
  return [15_000, 20_000, 30_000][Math.min(attempt, 2)];
}
