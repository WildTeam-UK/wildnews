import { dangerouslyDeleteByTag } from '@vercel/functions';
import { PUBLIC_PAGE_TAG, publicPageEpochKey, withPublicCacheDeadline } from './public-page-cache';
import { operationalLog } from './operational-log';
import { getPublicCacheStore, getPublicCacheDeployment } from './public-cache-store';

// Middleware and RSC/automation have separate bundles in the production output.
const key = Symbol.for('wildnews.public-page-invalidation.v1');
const registry = globalThis as typeof globalThis & { [key]?: Set<() => void> };
const listeners = registry[key] ??= new Set<() => void>();

export function onPublicPageInvalidation(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function invalidatePublicPages() {
  // Publication, revisions and admin edits must retire this worker's fallback,
  // even if the remote cache/CDN are unavailable.
  for (const listener of listeners) listener();
  const store = getPublicCacheStore();
  try {
    const results = await Promise.allSettled([
      (async () => {
        const key = publicPageEpochKey(getPublicCacheDeployment());
        const previous = await withPublicCacheDeadline(store.get(key));
        await withPublicCacheDeadline(store.expireTag(PUBLIC_PAGE_TAG));
        const value = crypto.randomUUID();
        await withPublicCacheDeadline(store.set(key, value, { ttl: 86400, tags: [PUBLIC_PAGE_TAG] }));
        const retained = await withPublicCacheDeadline(store.get(key));
        // A concurrent publisher may have rotated it again. Either fresh token
        // retires the previous generation; an unchanged/missing token does not.
        if (typeof retained !== 'string' || !retained || retained === previous) throw Object.assign(new Error('Cache invalidation was not retained'), { code: 'CACHE_NOT_RETAINED' });
      })(),
      // Attempt the CDN purge independently: a cache failure must not skip it.
      process.env.VERCEL === '1' ? dangerouslyDeleteByTag(PUBLIC_PAGE_TAG) : Promise.resolve(),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    await withPublicCacheDeadline(store.delete('invalidation-failure'));
  } catch (error) {
    operationalLog('error', { operation: 'public_cache_invalidation_failed' }, error);
    try { await withPublicCacheDeadline(store.set('invalidation-failure', true, { ttl: 600 })); }
    catch { /* Never replay an editorial change because diagnostics also failed. */ }
    // The editorial mutation has already committed. Never retry publication because
    // cache infrastructure failed; bounded TTLs still expire the old representation.
  }
}
