// A response may arrive after an account switch or a newer request. Only the
// latest generation may update account-scoped content in the browser.
export function createResponseEpoch() {
  let value = 0;
  return {
    current: () => value,
    invalidate: () => ++value,
    isCurrent: (captured) => captured === value,
  };
}
