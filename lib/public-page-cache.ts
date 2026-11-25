export const PUBLIC_PAGE_TAG = 'wildnews-public-pages-v1';
export const PUBLIC_PAGE_FAILURE = 'data-public-page-unavailable';
export const PUBLIC_PAGE_DEGRADED = 'data-public-page-degraded';
const FRESH_MS = 300_000;
const MAX_AGE_MS = 600_000;
const MAX_BODY_BYTES = 1_800_000;
const LOCAL_FRESH_MS = 30_000;
const CACHE_RETRY_MS = 30_000;
const MAX_LOCAL_BYTES = 24 * 1024 * 1024;
const MAX_LOCAL_ENTRIES = 64;

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

export const publicPageEpochKey = (deployment: string) => `${deployment}:epoch`;

export async function withPublicCacheDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Cache operation timed out'), { code: 'CACHE_TIMEOUT' })), 500);
    })]);
  } finally { clearTimeout(timer); }
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Snapshot;
  return typeof snapshot.body === 'string' && Number.isFinite(snapshot.createdAt)
    && Array.isArray(snapshot.headers) && snapshot.headers.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string'));
}

export function publicHtmlPath(request: Request): string | null {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  if (request.headers.has('rsc') || request.headers.has('next-router-state-tree') || request.headers.has('next-router-prefetch') || request.headers.has('next-action') || request.headers.get('accept')?.includes('text/x-component')) return null;
  return /^(?:\/|\/(?:stories|topics|tags)\/[a-z0-9-]+|\/(?:daily|weekly)-digest\/\d{4}-\d{2}-\d{2}|\/(?:digests|good-news-in-conservation|how-we-use-ai|how-coverage-analysis-works|how-we-classify-good-news|about))$/.test(url.pathname) ? url.pathname : null;
}

export function publicPagePath(request: Request): string | null {
  const path = publicHtmlPath(request);
  if (!path || request.headers.has('authorization')) return null;
  const url = new URL(request.url);
  if (/(?:^|;\s*)(?:sb-|__prerender_bypass|__next_preview_data)/.test(request.headers.get('cookie') ?? '')) return null;
  if ([...url.searchParams.keys()].some((key) => !key.startsWith('utm_') && !['_gl', 'gclid', 'fbclid'].includes(key))) return null;
  return path;
}

function unavailableHtml(body: string): boolean {
  return /<main\b[^>]*\bdata-public-page-unavailable(?:[\s=>])/.test(body) || /<template\b[^>]*\bdata-dgst=/.test(body);
}

// Used after the origin render when shared caching was bypassed or failed.
// Buffer HTML only; API, RSC and private routes never pass through this guard.
export async function protectPublicHtml(response: Response, head = false): Promise<Response> {
  if (!response.headers.get('content-type')?.includes('text/html') || [204, 205].includes(response.status) || (response.status >= 300 && response.status < 500)) {
    return head ? new Response(null, { status: response.status, headers: response.headers }) : response;
  }
  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  const failed = response.status >= 500 || unavailableHtml(body);
  if (failed) {
    headers.set('Cache-Control', 'no-store');
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Vercel-CDN-Cache-Control', 'no-store');
    for (const name of ['age', 'etag', 'vercel-cache-tag', 'x-wildnews-cache']) headers.delete(name);
  }
  return new Response(head ? null : body, { status: failed ? 503 : response.status, headers });
}

export function createPublicPageCache(options: Options) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<Response>>();
  const local = new Map<string, { snapshot: Snapshot; version: string | null; bytes: number }>();
  let localBytes = 0;
  let generation = 0;
  let readingEpoch: Promise<string | null> | undefined;
  let retryAt = 0;
  let cacheUnavailable = false;
  let cacheFailures = 0;
  const epochKey = publicPageEpochKey(options.deployment);

  function unavailable(error: unknown) {
    cacheFailures++;
    retryAt = now() + CACHE_RETRY_MS;
    if (!cacheUnavailable) options.report('public_page_cache_unavailable', error);
    cacheUnavailable = true;
  }

  function forget(path: string) {
    const entry = local.get(path);
    if (entry) localBytes -= entry.bytes;
    local.delete(path);
  }

  function remember(path: string, snapshot: Snapshot, version: string | null) {
    for (const [key, entry] of local) if (now() - entry.snapshot.createdAt >= MAX_AGE_MS) forget(key);
    forget(path);
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    local.set(path, { snapshot, version, bytes }); localBytes += bytes;
    while (local.size > MAX_LOCAL_ENTRIES || localBytes > MAX_LOCAL_BYTES) forget(local.keys().next().value!);
  }

  function localSnapshot(path: string, version: string | null): Snapshot | undefined {
    const entry = local.get(path);
    if (!entry) return;
    const age = now() - entry.snapshot.createdAt;
    if (age < 0 || age >= MAX_AGE_MS || (version !== null && entry.version !== version)) { forget(path); return; }
    local.delete(path); local.set(path, entry);
    return entry.snapshot;
  }

  async function epoch(): Promise<string | null> {
    if (now() < retryAt) return null;
    readingEpoch ??= (async () => {
      const observedFailures = cacheFailures;
      try {
        let value = await withPublicCacheDeadline(options.store.get(epochKey));
        if (typeof value !== 'string' || !value) {
          await withPublicCacheDeadline(options.store.set(epochKey, crypto.randomUUID(), { ttl: 86400, tags: [PUBLIC_PAGE_TAG] }));
          // The SDK resolves failed writes and turns failed reads into misses.
          // Never trust an epoch until it can actually be read back.
          value = await withPublicCacheDeadline(options.store.get(epochKey));
          if (typeof value !== 'string' || !value) throw Object.assign(new Error('Cache did not retain its epoch'), { code: 'CACHE_NOT_RETAINED' });
        }
        if (cacheFailures !== observedFailures) return null;
        if (cacheUnavailable) options.report('public_page_cache_recovered');
        cacheUnavailable = false; retryAt = 0;
        return value;
      } catch (error) { unavailable(error); return null; }
    })().finally(() => { readingEpoch = undefined; });
    return readingEpoch;
  }

  function snapshotResponse(snapshot: Snapshot, state: 'HIT' | 'STALE' | 'MISS', shared = true): Response {
    const headers = new Headers(snapshot.headers);
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    // A local fallback cannot observe another worker's invalidation during an
    // outage. Do not promote it into a fresh shared CDN representation.
    headers.set('Vercel-CDN-Cache-Control', shared ? `public, max-age=${state !== 'STALE' ? Math.max(0, Math.floor((FRESH_MS - (now() - snapshot.createdAt)) / 1000)) : 0}` : 'no-store');
    if (!shared) headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Vercel-Cache-Tag', PUBLIC_PAGE_TAG);
    headers.set('X-WildNews-Cache', shared ? state : `LOCAL-${state}`);
    headers.set('Age', String(Math.max(0, Math.floor((now() - snapshot.createdAt) / 1000))));
    return new Response(snapshot.body, { headers });
  }

  async function markFailure(path: string) {
    if (cacheUnavailable) return;
    try { await withPublicCacheDeadline(options.store.set('render-failure', { path }, { ttl: 600, tags: [] })); }
    catch (error) { unavailable(error); }
  }

  async function refresh(request: Request, path: string, version: string | null, key: string): Promise<Response> {
    const pendingKey = `${generation}:${key}`;
    let work = pending.get(pendingKey);
    if (!work) {
      const startedGeneration = generation;
      work = (async () => {
        const url = new URL(path, request.url);
        // Cache only a canonical anonymous HTML representation, never cookies or RSC.
        // Vinext applies htmlLimitedBots only to non-empty user agents. Use a
        // fixed anonymous agent so cached HTML also resolves metadata in head.
        const response = await options.render(new Request(url, { headers: { accept: 'text/html', 'user-agent': 'WildNews-Public-HTML/1.0' } }));
        if (!response.headers.get('content-type')?.includes('text/html')) return response;
        const body = await response.text();
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const failed = response.status === 200 && unavailableHtml(body);
        if (response.status >= 500 || failed) {
          options.report('public_page_render_failed');
          await markFailure(path);
          return protectPublicHtml(new Response(body, { status: 503, headers }));
        }
        const degraded = /<main\b[^>]*\bdata-public-page-degraded(?:[\s=>])/.test(body);
        const successful = response.status === 200 && !headers.has('set-cookie') && !degraded;
        if (successful && new TextEncoder().encode(body).length <= MAX_BODY_BYTES) {
          const snapshot: Snapshot = { body, headers: [...headers], createdAt: now() };
          let shared = false;
          let retired = generation !== startedGeneration;
          if (!retired && version !== null) {
            const current = await epoch();
            retired = current !== null && current !== version;
            if (!retired && current === version) {
              try {
                await withPublicCacheDeadline(options.store.set(key, snapshot, { ttl: MAX_AGE_MS / 1000, tags: [PUBLIC_PAGE_TAG] }));
                const retained = await withPublicCacheDeadline(options.store.get(key));
                if (!isSnapshot(retained) || retained.createdAt !== snapshot.createdAt || retained.body !== snapshot.body) throw Object.assign(new Error('Cache did not retain HTML'), { code: 'CACHE_NOT_RETAINED' });
                shared = true;
                const failure = await withPublicCacheDeadline(options.store.get('render-failure')) as { path?: string } | null;
                if (failure?.path === path) await withPublicCacheDeadline(options.store.delete('render-failure'));
              } catch (error) { unavailable(error); shared = false; }
            }
          }
          // Recheck after every awaited write: a mutation may have completed while
          // the cache operation was in flight.
          if (!retired && generation === startedGeneration) {
            remember(path, snapshot, shared ? version : null);
            return snapshotResponse(snapshot, 'MISS', shared);
          }
        }
        // A successful not-found/redirect refresh is authoritative. In
        // particular, stop serving a withdrawn article from a local fallback.
        if (response.status >= 300 && response.status < 500 && generation === startedGeneration) {
          forget(path);
          if (version !== null && !cacheUnavailable) {
            try { await withPublicCacheDeadline(options.store.delete(key)); }
            catch (error) { unavailable(error); }
          }
        }
        headers.set('Cache-Control', 'no-store');
        headers.set('CDN-Cache-Control', 'no-store');
        headers.set('Vercel-CDN-Cache-Control', 'no-store');
        headers.set('X-WildNews-Cache', 'BYPASS');
        return new Response(body, { status: response.status, headers });
      })().catch(async (error: unknown) => {
        options.report('public_page_render_threw', error);
        await markFailure(path);
        // Returning a protected response prevents middleware from rendering the
        // same failed origin a second time in this request.
        return protectPublicHtml(new Response('<!doctype html><html lang="en"><head><title>WildNews temporarily unavailable</title></head><body><main data-public-page-unavailable>WildNews is temporarily unavailable. Please try again shortly.</main></body></html>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60' } }));
      }).finally(() => { pending.delete(pendingKey); });
      pending.set(pendingKey, work);
    }
    return (await work).clone();
  }

  return {
    invalidate() { generation++; local.clear(); localBytes = 0; },
    async serve(request: Request): Promise<Response | null> {
      const path = publicPagePath(request);
      if (!path) return null;
      const observedGeneration = generation;
      let version = await epoch();
      let stored = localSnapshot(path, version);
      if (!stored && version !== null) {
        try {
          const value = await withPublicCacheDeadline(options.store.get(`${options.deployment}:${version}:${path}`));
          if (isSnapshot(value)) {
            stored = value;
            if (generation === observedGeneration) remember(path, value, version);
          }
        } catch (error) { unavailable(error); version = null; stored = localSnapshot(path, null); }
      }
      // A mutation may complete while an epoch/snapshot read is outstanding.
      // Do not let that older read refill local or CDN caches after the purge.
      if (generation !== observedGeneration) { version = null; stored = undefined; }
      const key = `${options.deployment}:${version ?? 'local'}:${path}`;
      const age = stored ? now() - stored.createdAt : Infinity;
      let response: Response;
      if (stored && age >= 0 && age < (version === null ? LOCAL_FRESH_MS : FRESH_MS)) response = snapshotResponse(stored, 'HIT', version !== null);
      else if (stored && age >= 0 && age < MAX_AGE_MS) {
        options.background(refresh(request, path, version, key).catch((error: unknown) => { options.report('public_page_refresh_failed', error); }));
        response = snapshotResponse(stored, 'STALE', version !== null);
      } else response = await refresh(request, path, version, key);
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
    },
  };
}
