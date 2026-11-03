import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Uses public credentials only. Every upstream production write is rejected.
const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
  throw new Error(
    'Provide the NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables.',
  );
let reads = 0;
let failure = 'none';
let failures = 0;
const topicFilters = [];
const fixtureId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
let withdrawn = false;
let fixtureSourceSlug = '';
const proxy = createServer(async (req, res) => {
  const url = new URL(req.url, env.NEXT_PUBLIC_SUPABASE_URL);
  if (url.pathname === '/auth/v1/user') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          id: userId,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'local-fixture@example.invalid',
          created_at: new Date().toISOString(),
        }),
      );
    return;
  }
  if (url.pathname === '/rest/v1/admin_users') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ user_id: userId }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (
      req.method === 'PATCH' &&
      url.pathname === '/rest/v1/stories' &&
      url.searchParams.get('id') === `eq.${fixtureId}`
    ) {
      withdrawn = true;
      res.writeHead(204).end();
      return;
    }
    if (
      url.pathname === '/rest/v1/editorial_actions' ||
      url.pathname === '/rest/v1/publication_queue'
    ) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
    return;
  }
  reads++;
  const fixture = url.searchParams.get('slug') === 'eq.cache-test-fixture';
  if (fixture && withdrawn) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    return;
  }
  if (fixture) url.searchParams.set('slug', `eq.${fixtureSourceSlug}`);
  const fail =
    failure === 'all' ||
    (failure === 'shelf' &&
      url.searchParams.get('homepage_topic.topics.name') === 'eq.Wildlife');
  if (failure === 'shelf')
    topicFilters.push(url.searchParams.get('homepage_topic.topics.name'));
  if (fail) {
    failures++;
    res
      .writeHead(500, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          code: '57014',
          message: 'Simulated statement timeout',
        }),
      );
    return;
  }
  try {
    const upstream = await fetch(url, {
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
        accept: req.headers.accept ?? 'application/json',
      },
    });
    res.writeHead(
      upstream.status,
      Object.fromEntries(
        [...upstream.headers].filter(
          ([k]) =>
            ![
              'content-encoding',
              'content-length',
              'transfer-encoding',
            ].includes(k),
        ),
      ),
    );
    if (fixture) {
      const data = await upstream.json();
      const row = Array.isArray(data) ? data[0] : data;
      row.id = fixtureId;
      row.slug = 'cache-test-fixture';
      res.end(JSON.stringify(Array.isArray(data) ? [row] : row));
    } else res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(502).end();
  }
});
await new Promise((r) => proxy.listen(3101, '127.0.0.1', r));
const app = spawn(process.execPath, ['.output/server/index.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:3101',
    SUPABASE_URL: 'http://127.0.0.1:3101',
    SUPABASE_SECRET_KEY: 'local-fixture-key',
    PORT: '3102',
    NODE_ENV: 'production',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [app.stdout, app.stderr])
  stream.on('data', (d) => {
    logs += d;
  });
const base = 'http://127.0.0.1:3102';
try {
  for (let n = 0; n < 100; n++) {
    try {
      await fetch(base + '/manifest.webmanifest');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const first = await fetch(base + '/');
  const body = await first.text();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-wildnews-cache'), 'MISS');
  assert.match(body, /Latest stories/);
  assert.doesNotMatch(body, /<main[^>]*data-public-page-degraded/);
  await writeFile('/tmp/wildnews-verified-home.html', body);
  fixtureSourceSlug = body.match(/href="\/stories\/([a-z0-9-]+)"/)[1];
  const baseline = reads;
  const started = Date.now();
  const burst = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      fetch(base + '/', { method: i % 2 ? 'HEAD' : 'GET' }),
    ),
  );
  await Promise.all(burst.map((r) => r.text()));
  assert.ok(
    burst.every(
      (r) => r.status === 200 && r.headers.get('x-wildnews-cache') === 'HIT',
    ),
  );
  assert.equal(reads, baseline);
  console.log(
    JSON.stringify({
      check: 'warm_30_request_burst',
      databaseReads: reads - baseline,
      durationMs: Date.now() - started,
      initialDatabaseReads: baseline,
    }),
  );
  failure = 'shelf';
  const optional = await fetch(base + '/?verify=optional');
  const optionalBody = await optional.text();
  await writeFile('/tmp/wildnews-verified-optional.html', optionalBody);
  console.log(
    JSON.stringify({ optionalReads: reads - baseline, failures, topicFilters }),
  );
  assert.equal(optional.status, 200);
  assert.ok(optionalBody.includes('Latest stories'));
  assert.ok(
    /<main[^>]*data-public-page-degraded/.test(optionalBody),
    'Optional failure marker missing',
  );
  console.log(
    JSON.stringify({
      check: 'shelf_failure',
      status: optional.status,
      mainContentReadable: true,
    }),
  );
  failure = 'all';
  const cached = await fetch(base + '/');
  assert.equal(cached.status, 200);
  await cached.text();
  const failing = await fetch(base + '/topics/wildlife');
  const errorBody = await failing.text();
  await writeFile('/tmp/wildnews-verified-failure.html', errorBody);
  assert.equal(failing.status, 503);
  assert.ok(logs.includes('wildnews_operation'));
  console.log(
    JSON.stringify({
      check: 'cold_database_failure',
      status: failing.status,
      structuredErrorsCaptured: true,
    }),
  );
  failure = 'none';
  const recovered = await fetch(base + '/topics/wildlife');
  assert.equal(recovered.status, 200);
  await recovered.text();
  console.log(
    JSON.stringify({
      check: 'recovery',
      status: recovered.status,
      cache: recovered.headers.get('x-wildnews-cache'),
    }),
  );
  const beforeCold = reads;
  const cold = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      fetch(base + '/topics/forests', { method: i % 2 ? 'HEAD' : 'GET' }),
    ),
  );
  await Promise.all(cold.map((r) => r.text()));
  assert.ok(cold.every((r) => r.status === 200));
  assert.ok(reads - beforeCold <= 4);
  console.log(
    JSON.stringify({
      check: 'cold_20_request_burst',
      databaseReads: reads - beforeCold,
    }),
  );
  const article = await fetch(base + '/stories/cache-test-fixture');
  assert.equal(article.status, 200);
  await article.text();
  const jwt = [
    { alg: 'HS256', typ: 'JWT' },
    {
      sub: userId,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    'local-signature',
  ]
    .map((v, i) =>
      i < 2 ? Buffer.from(JSON.stringify(v)).toString('base64url') : v,
    )
    .join('.');
  const session = {
    access_token: jwt,
    refresh_token: 'local-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId },
  };
  const cookie =
    'sb-127-auth-token=base64-' +
    Buffer.from(JSON.stringify(session)).toString('base64url');
  const unpublish = await fetch(
    base + `/api/admin/drafts/${fixtureId}/publish`,
    { method: 'DELETE', headers: { cookie } },
  );
  assert.equal(unpublish.status, 200, await unpublish.text());
  assert.equal(withdrawn, true);
  const after = await fetch(base + '/stories/cache-test-fixture');
  assert.equal(after.status, 404);
  await after.text();
  console.log(
    JSON.stringify({
      check: 'authenticated_local_unpublish_invalidates_cached_article',
      status: after.status,
      productionWrites: 0,
    }),
  );
  await writeFile('/tmp/wildnews-availability-server.log', logs);
} finally {
  await writeFile('/tmp/wildnews-availability-server.log', logs);
  app.kill('SIGTERM');
  proxy.close();
}
