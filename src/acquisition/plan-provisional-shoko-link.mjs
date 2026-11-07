import { planProvisionalShokoLinks } from './plan-provisional-shoko-links.mjs';

// Compatibility entry point for a single provisional file. The shared
// planner enforces the same catalogue and owned-file checks for packs.
export function planProvisionalShokoLink({ observed, ...input } = {}) {
  const result = planProvisionalShokoLinks({ ...input,
    observedFiles: observed === undefined ? [] : [observed] });
  if (result.state !== 'links_ready') return result;
  return result.links.length === 1 ? result.links[0]
    : { state: 'held', reason: 'shoko_file_unverified' };
}
