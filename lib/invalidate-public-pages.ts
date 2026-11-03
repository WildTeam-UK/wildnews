import { dangerouslyDeleteByTag } from '@vercel/functions';
import { PUBLIC_PAGE_TAG } from './public-page-cache';
import { operationalLog } from './operational-log';
import { getPublicCacheStore } from './public-cache-store';

export async function invalidatePublicPages() {
  try {
    await getPublicCacheStore().expireTag(PUBLIC_PAGE_TAG);
    if (process.env.VERCEL === '1') await dangerouslyDeleteByTag(PUBLIC_PAGE_TAG);
    await getPublicCacheStore().delete('invalidation-failure');
  } catch (error) {
    operationalLog('error', { operation: 'public_cache_invalidation_failed' }, error);
    await getPublicCacheStore().set('invalidation-failure', true, { ttl: 600 }).catch(() => {});
    // The editorial mutation has already committed. Never retry publication because
    // cache infrastructure failed; bounded TTLs still expire the old representation.
  }
}
