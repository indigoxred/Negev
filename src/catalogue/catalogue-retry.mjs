// Internal-only retry evidence. Symbols do not appear in API JSON or snapshots.
const retryAt = Symbol('catalogueRetryAt');
export const catalogueRetryAt = value => Number.isSafeInteger(value?.[retryAt]) ? value[retryAt] : null;
export function withCatalogueRetry(value, source) {
 const time=typeof source==='number'?source:catalogueRetryAt(source);
 if(Number.isSafeInteger(time)&&time>=0)Object.defineProperty(value,retryAt,{value:time});
 return value;
}
