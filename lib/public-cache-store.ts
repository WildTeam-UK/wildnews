import { getCache } from '@vercel/functions';
import { createHash } from 'node:crypto';

export function getPublicCacheStore() {
  return getCache({ namespace: 'wildnews-pages', keyHashFunction: (key) => createHash('sha256').update(key).digest('hex') });
}
