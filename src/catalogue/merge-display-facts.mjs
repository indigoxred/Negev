const dateYear = (value) => typeof value === 'string' && /^\d{4}-/.test(value)
  ? Number(value.slice(0, 4)) : null;

// The AniDB archive sometimes carries placeholder dates. Keep the raw
// catalogue unchanged and suppress a contradictory date in presentation only.
export function mergeDisplayFacts(display, facts) {
  if (display?.state !== 'display' || facts?.state !== 'facts') return display;
  const conflicts = (year) => Number.isSafeInteger(facts.year) &&
    Number.isSafeInteger(year) && Math.abs(facts.year - year) > 1;
  return { ...display,
    startYear: conflicts(display.startYear) ? null : display.startYear,
    startDate: conflicts(dateYear(display.startDate)) ? null : display.startDate,
    endDate: conflicts(dateYear(display.endDate)) ? null : display.endDate,
    season: facts.season, releaseStatus: facts.status,
    studio: facts.studio, durationMinutes: facts.durationMinutes };
}
