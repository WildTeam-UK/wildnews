export const PUBLIC_PAGE_TAG = 'wildnews-public-pages-v1';
export const PUBLIC_PAGE_FAILURE = 'data-public-page-unavailable';
export const PUBLIC_PAGE_DEGRADED = 'data-public-page-degraded';
const FRESH_MS = 60_000;
const MAX_AGE_MS = 300_000;
const MAX_BODY_BYTES = 1_800_000;

export type PageCacheStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, options: { ttl: number; tags: string[] }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};
type Snapshot = { body: string; headers: [string, string][]; createdAt: number };
type Options = {
  store: PageCacheStore;
  deployment: string;
  render: (request: Request) => Promise<Response>;
  background: (work: Promise<unknown>) => void;
  report: (operation: string, error?: unknown) => void;
  now?: () => number;
};

export function publicPagePath(request: Request): string | null {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method) || request.headers.has('authorization')) return null;
  if (request.headers.has('rsc') || request.headers.has('next-router-state-tree') || request.headers.has('next-router-prefetch') || request.headers.has('next-action') || request.headers.get('accept')?.includes('text/x-component')) return null;
  if (/(?:^|;\s*)(?:sb-|__prerender_bypass|__next_preview_data)/.test(request.headers.get('cookie') ?? '')) return null;
  if ([...url.searchParams.keys()].some((key) => !key.startsWith('utm_') && !['_gl', 'gclid', 'fbclid'].includes(key))) return null;
  return /^(?:\/|\/(?:stories|topics|tags)\/[a-z0-9-]+|\/(?:daily|weekly)-digest\/\d{4}-\d{2}-\d{2}|\/(?:digests|good-news-in-conservation|how-we-use-ai|how-coverage-analysis-works|how-we-classify-good-news|about))$/.test(url.pathname) ? url.pathname : null;
}

export function createPublicPageCache(options: Options) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<Response>>();
  let generation = 0;
  let initializingEpoch: Promise<string> | undefined;
  const epochKey = `${options.deployment}:epoch`;

  async function epoch(): Promise<string> {
    const existing = await options.store.get(epochKey);
    if (typeof existing === 'string') return existing;
    initializingEpoch ??= (async () => {
      const value = crypto.randomUUID();
      await options.store.set(epochKey, value, { ttl: 86400, tags: [PUBLIC_PAGE_TAG] });
      return value;
    })().finally(() => { initializingEpoch = undefined; });
    return initializingEpoch;
  }

  function snapshotResponse(snapshot: Snapshot, state: 'HIT' | 'STALE'): Response {
    const headers = new Headers(snapshot.headers);
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    // The application bounds stale content and verifies successful regeneration itself.
    headers.set('Vercel-CDN-Cache-Control', `public, max-age=${state === 'HIT' ? Math.max(0, Math.floor((FRESH_MS - (now() - snapshot.createdAt)) / 1000)) : 0}`);
    headers.set('Vercel-Cache-Tag', PUBLIC_PAGE_TAG);
    headers.set('X-WildNews-Cache', state);
    headers.set('Age', String(Math.max(0, Math.floor((now() - snapshot.createdAt) / 1000))));
    return new Response(snapshot.body, { headers });
  }

  async function refresh(request: Request, path: string, version: string, key: string): Promise<Response> {
    let work = pending.get(key);
    if (!work) {
      const startedGeneration = generation;
      work = (async () => {
        const url = new URL(path, request.url);
        // Cache only a canonical anonymous HTML representation, never cookies or RSC.
        const response = await options.render(new Request(url, { headers: { accept: 'text/html' } }));
        if (!response.headers.get('content-type')?.includes('text/html')) return response;
        const body = await response.text();
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const unavailable = /<main\b[^>]*\bdata-public-page-unavailable(?:[\s=>])/.test(body)
          || /\bdata-dgst=/.test(body);
        if (response.status >= 500 || unavailable) {
          options.report('public_page_render_failed');
          await options.store.set('render-failure', { path }, { ttl: 600, tags: [] }).catch(() => {});
          headers.set('Cache-Control', 'no-store');
          headers.set('Vercel-CDN-Cache-Control', 'no-store');
          return new Response(body, { status: 503, headers });
        }
        const degraded = /<main\b[^>]*\bdata-public-page-degraded(?:[\s=>])/.test(body);
        const successful = response.status === 200 && !headers.has('set-cookie') && !degraded;
        if (successful && new TextEncoder().encode(body).length <= MAX_BODY_BYTES) {
          const snapshot: Snapshot = { body, headers: [...headers], createdAt: now() };
          // An editorial invalidation must also retire renders already in flight.
          if (generation === startedGeneration && await epoch() === version) {
            try {
              await options.store.set(key, snapshot, { ttl: MAX_AGE_MS / 1000, tags: [PUBLIC_PAGE_TAG] });
              const failure = await options.store.get('render-failure') as { path?: string } | null;
              if (failure?.path === path) await options.store.delete('render-failure');
            } catch (error) { options.report('public_page_cache_write_failed', error); }
            const result = snapshotResponse(snapshot, 'HIT');
            result.headers.set('X-WildNews-Cache', 'MISS');
            return result;
          }
        }
        headers.set('Cache-Control', 'no-store');
        headers.set('Vercel-CDN-Cache-Control', 'no-store');
        headers.set('X-WildNews-Cache', 'BYPASS');
        return new Response(body, { status: response.status, headers });
      })().catch(async (error: unknown) => {
        options.report('public_page_render_threw', error);
        await options.store.set('render-failure', { path }, { ttl: 600, tags: [] }).catch(() => {});
        throw error;
      }).finally(() => { pending.delete(key); });
      pending.set(key, work);
    }
    return (await work).clone();
  }

  return {
    invalidate() { generation++; },
    async serve(request: Request): Promise<Response | null> {
      const path = publicPagePath(request);
      if (!path) return null;
      const version = await epoch();
      const key = `${options.deployment}:${version}:${path}`;
      const stored = await options.store.get(key) as Snapshot | undefined;
      const age = stored ? now() - stored.createdAt : Infinity;
      let response: Response;
      if (stored && age >= 0 && age < FRESH_MS) response = snapshotResponse(stored, 'HIT');
      else if (stored && age >= 0 && age < MAX_AGE_MS) {
        options.background(refresh(request, path, version, key).catch((error: unknown) => { options.report('public_page_refresh_failed', error); }));
        response = snapshotResponse(stored, 'STALE');
      } else response = await refresh(request, path, version, key);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    },
  };
}
