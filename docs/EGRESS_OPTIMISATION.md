# Egress optimisation

## Changes

Anonymous public HTML is fresh for 300 seconds, increased from 60 seconds. The existing invalidation paths still expire snapshots after publishing, unpublishing, archiving and editorial updates. A successful old snapshot may be served during refresh until its original age reaches 600 seconds. After that, a failed render returns an error instead of retaining content indefinitely. CDN freshness counts down from the original snapshot timestamp; a cache hit cannot restart the five-minute clock.

Admin, authenticated-cookie, API, RSC, preview and semantic-query requests keep their existing bypass behaviour. The admin article list remains authenticated and uncached, but now projects only the topic and model fields from generation metadata instead of downloading all article bodies. Detail views are unchanged.

## Verification

```sh
pnpm exec tsc --noEmit
pnpm exec oxlint app/admin/drafts/page.tsx lib/public-page-cache.ts tests/public-page-cache.test.ts
node --experimental-strip-types --test tests/public-page-cache.test.ts
pnpm build
git diff --check
```

Cache tests cover a 30-request GET/HEAD burst, five-minute freshness, ten-minute maximum age, failed refreshes, private-response bypass and invalidation while an older render is in flight. Five visits one minute apart use one render instead of expiring once per minute; actual production savings depend on traffic and invalidation frequency.

Run the existing `scripts/verify-public-availability.mjs` against a production build with the two browser-safe Supabase variables supplied in the process environment. It reads public production data through a local proxy on ports 3101/3102; all writes are blocked except synthetic local fixtures. The verified checks are zero extra database reads for 30 warm requests, one shared render for a cold burst, optional-section degradation, failure recovery, and immediate removal of a cached fixture after an authenticated local unpublish. No real admin credentials are needed and no production records are changed.

On 11 November 2026 the production-server check passed: 30 warm requests added zero database reads, 20 simultaneous cold topic requests used three reads, and the withdrawn fixture immediately returned 404. Comparing the old and new article-list projections on the same 20 public stories reduced uncompressed JSON from 217,156 bytes to 10,877 bytes (95%), with identical primary topic and model values. This validates the projection without exposing or changing private drafts; wire compression and the mix of production traffic will determine the total billing impact.

## Production comparison

The 13 November 2026 CPU change also gates idle automation at the existing Supabase minute scheduler. Due work still wakes the same endpoint on the next minute tick, while an idle worker is probed every four minutes. `tests/automation-due.test.mjs` executes the real migration against PGlite and covers daily and digest recovery, source collection, publication handoff, coverage, retention, delivery retries, expired leases and restricted execution. The predicate changes neither the public-page cache lifetime nor the editorial/publication limits.

Social review now requires each opening and body paragraph to carry its own source-story IDs in the structured response. The application constructs the stored paragraph-to-evidence map from that result, preventing an independent evidence array from omitting or mismatching a paragraph. Independent editorial review, deterministic validation, provider leases and duplicate-delivery safeguards remain in place.

Unsubmitted social deliveries expire as `unsent` two hours after the digest's stored scheduled publication time (`period_end`). The minute scheduler closes pending or failed deliveries without waking Vercel solely for expiry. The worker also checks before generation and immediately before Buffer submission, and manual retries cannot reopen an expired edition. Buffer-accepted deliveries and uncertain provider outcomes retain their existing safeguards; weekly email handling is unchanged. Expiry retains an audit event and removes the failed delivery from active workflow health. The SQL and clock regression tests cover the exact deadline, idempotency, provider exceptions and restricted access.

The 11 November 2026 investigation found 4.372 GB of WildNews egress in the displayed 15 October–15 November cycle, versus 2.825 GB for WildJobs. On 10 November, PostgREST accounted for 98.4% of combined egress. Those are historical baselines, not a forecast of savings.

After deploying, compare complete days of this project's database API egress with comparable traffic and editorial activity. Supabase reporting can lag by an hour. Check both the homepage and story routes for cache reuse, then verify a publication or withdrawal appears promptly. Existing requests bypassing anonymous HTML caching will continue to read current data; the separate admin-list projection reduces the bytes per read there.

The organisation shares a 5 GB allowance, approximately 167 MB/day over a 30-day cycle. Track both apps together and retain headroom for backups, imports and development. Accumulated egress cannot be removed retrospectively; use new daily measurements to decide whether Free remains viable. These changes do not upgrade the subscription or deploy themselves.
