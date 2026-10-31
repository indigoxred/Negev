// Share one paced availability slot between changed Shoko files and user
// title checks. Three direct slots to one title slot prevent either queue
// from starving while an idle queue yields immediately to the other.
export function createAvailabilityCycle({ runDirect, runTitle } = {}) {
  if (typeof runDirect !== 'function' && typeof runTitle !== 'function') {
    throw new TypeError('Availability worker required');
  }
  if ((runDirect != null && typeof runDirect !== 'function') ||
      (runTitle != null && typeof runTitle !== 'function')) {
    throw new TypeError('Invalid availability worker');
  }
  let turn = 0;
  return {
    async runOnce() {
      if (!runDirect) return runTitle();
      if (!runTitle) return runDirect();
      const first = ++turn % 4 === 0 ? runTitle : runDirect;
      const second = first === runDirect ? runTitle : runDirect;
      const result = await first();
      return result?.state === 'idle' ? second() : result;
    },
  };
}
