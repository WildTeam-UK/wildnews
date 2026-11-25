import { getCache } from '@vercel/functions';
import { createHash } from 'node:crypto';
import { withPublicCacheDeadline } from './public-page-cache';
import { operationalLog } from './operational-log';

export const getPublicCacheDeployment = () => process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? 'local';

export function getPublicCacheStore() {
  return getCache({ namespace: 'wildnews-pages', keyHashFunction: (key) => createHash('sha256').update(key).digest('hex') });
}

let probe: Promise<boolean> | undefined;
let probeUntil = 0;

// A miss is not a cache-health check: SDK failures can look exactly like misses.
// Exercise storage with an isolated, short-lived token and verify the read-back.
export function checkPublicCache() {
  if (!probe || Date.now() >= probeUntil) {
    probeUntil = Date.now() + 30_000;
    probe = (async () => {
      const store = getPublicCacheStore();
      const key = `${getPublicCacheDeployment()}:health:${crypto.randomUUID()}`;
      const value = crypto.randomUUID();
      try {
        await withPublicCacheDeadline(store.set(key, value, { ttl: 60 }));
        if (await withPublicCacheDeadline(store.get(key)) !== value) throw Object.assign(new Error('Cache health probe was not retained'), { code: 'CACHE_NOT_RETAINED' });
        return true;
      } catch (error) {
        operationalLog('error', { operation: 'public_cache_health_failed' }, error);
        return false;
      } finally {
        try { await withPublicCacheDeadline(store.delete(key)); }
        catch { /* The isolated probe also expires after 60 seconds. */ }
      }
    })();
  }
  return probe;
}
