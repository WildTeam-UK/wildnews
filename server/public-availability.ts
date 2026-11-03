import { defineMiddleware, definePlugin } from 'nitro';
import { waitUntil } from '@vercel/functions';
import { createPublicPageCache, publicPagePath } from '../lib/public-page-cache';
import { invalidatePublicPages } from '../lib/invalidate-public-pages';
import { operationalLog } from '../lib/operational-log';
import { getPublicCacheStore } from '../lib/public-cache-store';

export default definePlugin((nitro) => {
  const internalRequests = new WeakSet<Request>();
  const pages = createPublicPageCache({
    store: getPublicCacheStore(),
    deployment: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_URL ?? 'local',
    render: async (request) => {
      internalRequests.add(request);
      return nitro.fetch(request);
    },
    background: (work) => waitUntil(work),
    report: (operation, error) => operationalLog('error', { operation }, error),
  });
  const headCounts = new Map<string, { count: number; until: number }>();
  // Nitro's H3Core exposes its startup middleware list, rather than H3.use().
  nitro.h3?.['~middleware'].push(defineMiddleware(async (event, next) => {
    if (internalRequests.has(event.req)) return next();
    const path = event.url.pathname;
    const publicPath = publicPagePath(event.req);
    // Observation only, no visitor blocking. Store a short-lived counter, never IPs.
    if (publicPath && event.req.method === 'HEAD') {
      const minute = Math.floor(Date.now() / 60_000);
      const route = publicPath.replace(/\/(stories|topics|tags)\/[^/]+$/, '/$1/[slug]').replace(/\/(daily|weekly)-digest\/[^/]+$/, '/$1-digest/[date]');
      const key = `${minute}:${route}`;
      const count = (headCounts.get(key)?.count ?? 0) + 1;
      headCounts.set(key, { count, until: (minute + 1) * 60_000 });
      for (const [oldKey, value] of headCounts) if (value.until < Date.now()) headCounts.delete(oldKey);
      if (count === 20 || count % 100 === 0) operationalLog('warn', { operation: 'public_head_burst_observed', route: publicPath });
    }
    if (publicPath) {
      try {
        const response = await pages.serve(event.req);
        if (response) return response;
      } catch (error) {
        operationalLog('error', { operation: 'public_page_cache_failed', route: path }, error);
        // Cache infrastructure failure must not make a healthy origin unavailable.
      }
    }
    const response = await next();
    if (path.startsWith('/api/admin/') && !['GET', 'HEAD', 'OPTIONS'].includes(event.req.method)
      && response instanceof Response && (response.ok || response.status >= 500)) {
      pages.invalidate();
      await invalidatePublicPages();
    }
    return response;
  }));
});
