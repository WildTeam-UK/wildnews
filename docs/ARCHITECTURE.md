# WildNews architecture

This document records the application architecture currently implemented in the repository. It must be updated when a service boundary, deployment process, environment variable, database object or core data flow changes.

## System overview

WildNews is a server-rendered React application that collects conservation coverage, groups and assesses source items, researches qualifying stories, generates source-linked editorial briefings, schedules publication, and produces daily or weekly digests.

```text
RSS sources
    |
    v
Supabase source_items -> AI assessment and clustering -> ranked candidates
                                                        |
                                                        v
                                              research packs + sources
                                                        |
                                                        v
                                              generated private drafts
                                                        |
                                                        v
                                          publication queue -> public stories
                                                        |
                                  +---------------------+--------------------+
                                  |                                          |
                                  v                                          v
                         daily/weekly digests                       public archives/SEO
                                  |
                         Buffer social/Brevo email distribution
```

The public application reads published records with the Supabase publishable key. Authenticated admin pages use Supabase Auth and verify membership in `admin_users`. Privileged ingestion, automation and AI operations use a server-only Supabase service-role client.

## Repository and delivery

- Repository: `https://github.com/WildTeam-UK/wildnews.git`
- Primary branch: `main`
- Feature work is performed on separate branches, previewed by Vercel, reviewed, then merged into `main`.
- Vercel production project: `wildnews` (the legacy `conservation-news.vercel.app` alias remains attached)
- Intended canonical domain: `https://news.wildteam.org.uk`
- Current framework declaration: Nitro in `vercel.json`
- Build command: `vite build`
- Application build script: `vite build`
- Production start command: `node .output/server/index.mjs`
- Supported Node.js runtime: 22.13 or newer
- Pinned package manager: pnpm 11.25.0

Preview deployments are marked `noindex`. Production metadata permits indexing of public pages while `robots.txt` excludes `/admin/` and `/api/`.

Vercel applies browser-security headers to every route: MIME sniffing is disabled, framing is denied, cross-origin referrers are limited to their origin, and unused camera, geolocation, microphone, payment and USB capabilities are disabled. The Content Security Policy restricts pages to same-origin code and fonts, permits the inline hydration and style output required by the current Vinext/React implementation, permits browser connections only to WildNews and Supabase, and permits HTTPS editorial images because administrators may supply attributed images outside Unsplash or Supabase Storage.

## Framework and principal dependencies

### Runtime

- React 19
- Vinext 1, providing the Next-compatible App Router runtime on Vite
- Vite 8
- Nitro 3, producing the Vercel server output
- TypeScript
- Supabase JS and Supabase SSR
- OpenAI JavaScript client
- Vercel Speed Insights for production Core Web Vitals
- `fast-xml-parser` for RSS ingestion
- Lucide React for interface icons

### Styling

- Global CSS in `app/globals.css`
- Admin workspace CSS in `app/admin-workspace.css`
- Versioned WildTeam foundations from `@wildteam-uk/tokens` and `@wildteam-uk/ui`
- WildNews-owned editorial layouts and specialist public/admin components layered on those shared foundations
- Local VAG Rounded font files under `public/fonts`

The unused generic starter component collection and its component-only dependencies were removed during pre-launch cleanup. Public and admin interfaces continue to use WildNews-owned components in `components/`; stable ecosystem primitives can be adopted from the versioned shared UI package when their behaviour matches the application.

## Repository structure

| Path | Responsibility |
| --- | --- |
| `app/` | App Router pages, layouts, metadata routes and HTTP endpoints |
| `app/admin/` | Authenticated editorial workspace |
| `app/api/admin/` | Authenticated/manual editorial operations |
| `app/api/automation/` | Secret-authenticated scheduled heartbeat |
| `components/` | Public and admin React components |
| `lib/` | Editorial, ingestion, AI, publishing, taxonomy, SEO and service logic |
| `lib/supabase/` | Browser, SSR and service-role Supabase clients |
| `lib/openai/` | Assessment, research, drafting and digest generation |
| `lib/images/` | Unsplash integration, attribution and colour handling |
| `supabase/migrations/` | Ordered production database migrations |
| `public/` | Fonts, favicon, logo and social-sharing image |
| `docs/` | Architecture, design and database documentation |
| `.github/workflows/` | Repository automation, including encrypted database backups |
| `vite.config.ts` | Vinext, Nitro and local development-server configuration |

## Public routes

Core public routes are:

- `/`: latest stories plus independently queried topic shelves containing up to 12 recent published stories per editorial topic
- `/stories/[slug]`: standard news briefing
- `/daily-digest/[date]`: daily editorial digest
- `/weekly-digest/[date]`: Friday weekly digest
- `/digests`: combined digest archive
- `/topics/[topic]`: controlled topic archive
- `/tags/[tag]`: approved discovery-tag archive
- `/good-news-in-conservation`: positive-outlook archive
- `/how-we-use-ai`
- `/how-coverage-analysis-works`
- `/how-we-classify-good-news`
- `/about`

Machine-readable routes include `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` and `/llms.txt`.

## Admin routes

The admin workspace covers:

- Overview and system activity
- Collection pipeline, collected items and ranked candidates
- Articles and draft editing
- Contextual-link health, diagnostics and controlled reassessment
- Publication schedule
- Daily and weekly digests
- Monitored sources and source recommendations
- Topics, tags and Good News classification
- Training courses and course recommendations
- User settings

`app/admin/layout.tsx` marks the entire admin area `noindex`, `nofollow`, `noarchive` and `nocache`.

## Supabase integration

### Clients and trust boundaries

- `lib/supabase/browser.ts`: browser-safe client using the public URL and publishable key.
- `lib/supabase/server.ts`: cookie-aware SSR client used for authentication and user-scoped operations.
- `lib/supabase/admin.ts`: cached service-role client for server-only privileged work.
- `lib/supabase/require-admin.ts`: verifies the authenticated Supabase user has an active `admin_users` record.

Public read policies expose active taxonomy and published editorial records. Admin policies call the authenticated-only, security-invoker `is_content_admin()` function, which checks the caller's own RLS-visible admin record. The internal `rls_auto_enable()` event-trigger function is not executable through the Data API. The service role performs scheduled and privileged processing.

### Principal data groups

- Identity: `admin_users`
- Taxonomy: `topics`, `content_tags`, aliases and story/cluster joins
- Sources: `sources`, `source_topics`, `source_items`, ingestion runs, per-source ingestion tasks, the security-invoker `source_performance` view and reviewable source-network recommendations
- Editorial grouping: `story_clusters`, cluster items and reviewable cluster updates
- Published content: `stories`, topics, organisations, sources and contextual links
- Revision history: protected story editorial revisions and their linked coverage updates
- AI evidence: `ai_generations`, `research_packs`, linking assessments
- Daily workflow: editorial settings, runs, run items and run events
- Publishing: `publication_queue`
- Digests: digest settings, runs, selected stories and events
- Source discovery: source suggestions and mentions
- Learning signals: anonymous content interactions, 30-day content and source outcome views, and the source-learning policy
- Training: training courses and story recommendations
- Good News: settings and conservation-outlook records

Database changes are append-only migrations. Existing production migrations must not be rewritten.

## Editorial data flow

### Collection and assessment

1. A collection run snapshots the enabled RSS sources into durable per-source tasks.
2. Each request leases up to 10 source tasks and checks up to five feeds concurrently, retaining the existing 20-second per-feed timeout.
3. Interrupted task leases expire and become claimable again; a failed source does not repeat successful checks.
4. Previously unseen items are inserted into `source_items`.
5. Recent unprocessed items are claimed in assessment batches.
6. OpenAI assesses relevance, quality, evidence, timeliness and related signals.
7. Qualifying items become or join story clusters; rejected items remain assessed and are not repeatedly charged.
8. Every qualifying cluster remains a candidate until it is drafted, rejected or becomes stale; candidate creation is not capped by the daily draft limit.
9. Active undrafted candidates receive a time-sensitive effective score. The default removes two points per complete day since the latest supporting source and adds a deliberately small three-point bonus when Wildlife is the primary topic. Geography is not a ranking factor.
10. The daily run applies the configured minimum overall and evidence scores before spending money on research, then researches and drafts only the highest-ranked eligible candidates needed to fill that day's remaining article target. Candidates below those automation thresholds remain visible for manual review. Candidates older than the configurable seven-day freshness window remain stored for audit but are excluded from automation and the active Candidates workspace.

Manual collection, periodic collection and the daily editorial run use the same resumable collection mechanism. The admin request reports completed progress immediately; the minute heartbeat continues any remaining source tasks. Once per day, an otherwise idle heartbeat clears old replaceable `raw_content` in a bounded batch after the configured 30-day retention period. It preserves item metadata, URLs, hashes and assessment history, and excludes payloads supporting stories, research packs or pending coverage updates. Retention runs are logged. Source-item row deletion remains deferred until production history supports a safe policy.

The source workspace rolls this history into collection health, 30-day candidate yield, research use, published contribution and coverage-update use. A completed editorial run refreshes deterministic warnings for outlet dominance, repeated collection failures, low-yield feeds and thin topic coverage. The initial dominance threshold is more than 25% of at least 20 published news articles over 30 days. Contribution measures can overlap because a published article may draw on more than one monitored source. These signals never adjust candidate scores or change the monitored source list. An editor must accept or dismiss each recommendation, and that outcome is retained for later calibration.

Candidate freshness days, daily score decay and the wildlife bonus are stored in `editorial_run_settings` and can be adjusted with the existing daily workflow controls. Effective scores are calculated from the original assessment score at read or selection time, so the underlying AI assessment remains intact and the ranking naturally changes as candidates age.

### Research and drafting

1. A selected candidate receives a research pack using its source coverage and web research.
2. Source suggestions discovered during research are accumulated for later feed review.
3. OpenAI generates a structured article conforming to the shared article template and house style.
   Newly created articles use `article_content.template_version: 3`. Core copy targets 450–600 words across two overview paragraphs, five substantial key points, significance and next steps. Cleaning and publication checks require at least 350 core words, excluding titles, the listing standfirst and optional uncertainties. Generation keeps `what_we_know` empty and uses the existing `what_we_dont_know` field for zero to three distinct, sourced “What's still unclear” points. Essential caveats remain beside their core claims. Existing, scheduled and legacy articles retain their original version and sections; editor saves and later coverage revisions preserve that version. No editorial records are backfilled or rewritten for this change.
   The revision-application database function formats the derived `stories.body` according to that same stored version, omitting empty optional sections for version 3 while retaining the original version 2 formatting. Its permissions, row locks and revision history remain unchanged.
4. Taxonomy, conservation outlook and the featured course recommendation are attached.
5. A separate OpenAI link-editor pass examines the final copy against approved related articles, active topics, approved tags, courses and verified sources. Deterministic validation then enforces exact complete-word anchors, confidence thresholds, destination limits and duplicate prevention before accepted links are stored.

Published article pages identify WildNews as a synthesis and summary of the linked source reporting. This disclosure is intentionally article-only so digest editions retain their existing editorial presentation.
6. Proposed, accepted and rejected counts, rejection categories, token usage, cost and retryable failures are recorded in `story_linking_assessments`.
7. The result remains private after generation. It can then enter the publication queue or be published manually.

### Publication

Eligible drafts from the current editorial run enter `publication_queue`. The daily article target is the single limit for drafting and publishing. If research finds fewer than three usable sources or a research or drafting step fails, the run selects the next ranked eligible candidate until it reaches the target, exhausts the candidate pool or reaches the cost safeguard. A completed research pack with fewer than three sources remains available for manual review but is not repeatedly selected by later automatic runs; new coverage invalidates that pack and makes the candidate eligible for fresh research again. The queue distributes completed articles only across the remaining portion of that same day's configured London publishing window; it does not create a future-day backlog. A database claim function permits only one due publication per heartbeat and recovers interrupted publications after five minutes. The overall, evidence and source thresholds, along with the complete publication checklist, are checked again before publication as a defence in depth. Drafts held by those final safeguards can be reviewed and explicitly approved by an authenticated editor; the queue records that approval and still reruns the content publication checklist before the scheduled article goes live.

Slow editorial steps hold a five-minute lease, renewed every 30 seconds. Workers verify ownership after external operations and immediately before saving a generated draft. Initial and replacement shortlist insertion is a locked database transaction, fenced by the active lease token; viable work is capped at the run target and an initial shortlist cannot be appended twice. The runner also checks the actual completed-item count before starting more research or drafting. A run that crosses into another London day stops before selecting or generating more articles.

Completed, partial and budget-stopped runs record a durable `publication_queue_completed_at` handoff marker. A budget stop still submits its completed drafts to the ordinary checked queue; the heartbeat retries interrupted handoffs. Historical runs, previous-day scheduled entries and unused queue overflow cannot automatically consume the next day's capacity. Bulk scheduling counts both actual published news and reserved queue slots without double counting a story; the database serializes publication claims against the settings row and counts published news plus in-flight claims before admitting the next article. Digests do not consume the article limit. Unused drafts remain private for deliberate editorial review, while each morning collects and ranks the current undrafted candidate pool afresh. Explicit manual queue admission remains available through the existing editor controls. See [publishing recovery](PUBLISHING_RECOVERY.md) for a checked, bounded one-off recovery when a failed day is discovered after its publication window.

An editor can resume a budget-stopped run on its original London day. Resumption reopens its publication handoff, and the runner counts its own already queued or published drafts once when calculating remaining work, while preserving capacity reserved by other runs or manual publications.

The database keeps an article's `stories.status` as `draft` until it becomes public. Admin workflow labels combine that private/public state with `publication_queue.status`: **Unscheduled** articles are private and outside the active queue, **Scheduled** covers queued, scheduled and currently publishing articles, **Held** identifies private articles requiring attention, and **Published** identifies live articles. These admin groups are mutually exclusive even though unscheduled, scheduled and held records remain database drafts.

Editors can archive either a private or published news article without deleting its sources, revisions, interaction history or original publication date. Archiving cancels any queue record, removes a published article from every public query and excludes it from active update review. The archive is recoverable through the Articles workspace; restoring returns the record as an unscheduled private draft and never requeues it automatically. New reporting matched to an archived cluster is retained as cluster coverage but does not create editorial-update work unless the article is restored.

Published content is read dynamically for the homepage, archives, related stories, sitemap, structured data and `llms.txt`.

Anonymous public HTML is protected by the Nitro `server/public-availability.ts` middleware and the Vercel Runtime Cache. Successful representations are fresh for five minutes; a previous successful representation may be served while refreshing until its original age reaches ten minutes. Concurrent GET and HEAD misses share a render within each function instance, and both use the same canonical GET representation. Cache entries are separated by deployment identity to prevent old HTML referring to a different deployment's JavaScript. Tracking parameters do not multiply cache entries. Admin, API, authenticated-cookie, preview-cookie, RSC, action and semantic-query requests bypass this cache. Only successful, complete, cookie-free HTML below the cache item size limit is stored. Error boundaries and streamed server errors become HTTP 503 and are not cached; partially degraded homepages remain readable but are not stored.

Public lists project only their required metadata instead of whole generated articles. The authenticated admin article list likewise projects only its primary topic and generation model from JSON metadata; full article bodies remain detail-view reads. Topic navigation queries populated topics directly. React request memoization shares repeated metadata/body reads, and public database requests have a six-second deadline without automatic application retries. Optional homepage shelves, Good News badges, article recommendations and related digest editions do not prevent the principal content rendering.

Successful admin mutations invalidate public pages. Automatic article publication, digest publication and applied editorial revisions also invalidate them. Runtime entries and CDN representations use the `wildnews-public-pages-v1` tag; invalidation retires an epoch so older in-flight renders cannot repopulate the current cache. The CDN freshness never extends beyond the snapshot's original five-minute lifetime. Cache invalidation failures are logged without retrying an already committed publication; the bounded cache lifetime remains the final safeguard. Direct database changes outside these application workflows rely on expiry and require an explicit cache purge for urgent removals. No private data is cached. The official SDK uses memory locally; production verification must confirm that Vercel supplies Runtime Cache support. See [egress optimisation and measurement](EGRESS_OPTIMISATION.md) for the rollout checks.

New reporting matched to an existing news cluster creates a pending coverage update. When article-update automation is enabled, the heartbeat atomically leases one article's pending sources, groups up to five of them into one protected revision, and supplies the collected source text, existing structured article and source map to the dedicated update editor. It makes the smallest source-grounded copy changes justified by the new reporting and preserves unchanged copy and citations. If the reporting adds no meaningful public information, the revision is explicitly marked source-only instead of rewriting for stylistic variety. OpenAI then compares the stored before-and-after article content and linked coverage evidence to generate the concise public “What changed” summary. Generation and validation must succeed before the revision can be applied. Applying the revision is an explicit database transaction that updates the article and source coverage, records the revision decisions, and preserves the original `published_at` value. Leases recover interrupted work, retries are delayed, and processing stops after three failed attempts so an editor can use the existing review controls. Disabling update automation restores the fully manual prepare, review and apply path. The application records revision-draft and summary generations with their estimated costs in `ai_generations`. Source-only revisions retain their source and audit history without changing the SEO editorial modification date. Applied content and source-only revisions appear in a compact public editorial-history disclosure using only the safe revision date, description, type and stable `source-N` references exposed through RLS; those references cite the same numbered reporting listed on the article while private before-and-after content remains admin-only. A database trigger also prevents later news-article updates from replacing an existing publication timestamp accidentally. Published revisions with genuine copy changes set `editorial_updated_at` and the generated public change summary. Routine metadata changes and corrections update the database audit timestamp but do not create a public editorial-update date. Unpublishing an article for correction also preserves its original publication date for later republication.

Public article dates therefore use `published_at` as the original publication date and `editorial_updated_at` only for an explicitly applied editorial content update. Articles with applied revisions show their original date, latest revision date and expandable history, including source-only additions. Chronological archives continue to order by `published_at`, while SEO `dateModified` and sitemap modification dates use the editorial update date only when public article copy changed. Existing articles are not backfilled with editorial update timestamps.

### Digests

At 09:00 UK time, published stories from the completed reporting period are selected. Each scheduled run stores explicit inclusive start and exclusive end boundaries at the previous edition time, calculated in London calendar time so daylight-saving changes do not shorten, lengthen or shift retry evidence. Monday–Thursday and weekend runs create daily digests; Friday creates a weekly digest instead. Daily editions use editorial scores to choose the strongest eligible stories when the configured maximum is exceeded. Weekly editions consider up to 500 eligible stories, score their conservation significance, evidence, practitioner relevance, novelty and original assessment, then apply deliberately soft topic, place and primary-source repetition penalties while choosing up to 25. These penalties improve breadth without allowing a substantially weaker story to displace an important development. The selected order and score adjustments are retained in the run events for audit.

Digest generation supplies one primary and two progressively broader visual search terms for the edition's overarching theme. The server searches Unsplash independently, rejects images already attached to the digest's source articles or recent digests, records the selected image and attribution, and triggers Unsplash download tracking. It does not repurpose a source article's featured image for the digest. Once the connected editorial copy is final, the same dedicated link-editor and deterministic validation process assesses approved source stories, related articles, active topics, approved tags, courses and underlying reporting. Accepted digest links remain in the structured digest content while their assessment diagnostics are stored in `story_linking_assessments`. Digests publish immediately when that setting is enabled. Once an edition is public, a leased social-editorial delivery uses the final digest, published source-story evidence and recent social posts to generate, independently review and validate the social edition before creating independently tracked Buffer channel deliveries. Every editorial paragraph must begin with one distinct, subject-relevant and tonally appropriate emoji; deterministic validation rejects missing, misplaced, repeated or inapplicable fire emojis. The application inserts a newspaper emoji on the canonical digest-link line. Friday's weekly edition can also create and send a Brevo campaign to the existing Weekly Digest list. Daily editions are not emailed because the public subscription promise is weekly. Distribution is disabled by default and can be enabled independently for Buffer and Brevo in the admin workspace.

## Scheduling and recovery

Supabase `pg_cron` calls the Vercel automation endpoint once per minute through `pg_net`. The request uses a bearer secret stored in Supabase Vault.

The minute scheduler first calls the private, non-public `wildnews_automation_due()` selector. It starts the existing Vercel worker for due publication, editorial, digest, delivery, collection, coverage-update and retention work, including interrupted leases and publication handoffs. When idle, it sends a real worker probe at least every four minutes instead of starting a function on every tick. Only the application acknowledges the heartbeat; the database does not fabricate successful ticks. The ten-minute health threshold and existing claims, leases, retries, timing and cost limits are unchanged. The selector is conservative: unnecessary wake-ups are preferable to suppressing eligible work.

The heartbeat:

- Publishes one due queued story.
- Claims or advances the daily editorial run.
- Claims and applies one grouped article coverage revision when update automation is enabled and no daily run needs advancing.
- Claims or recovers a due digest run.
- Claims one due external digest delivery, with each Buffer channel and Brevo campaign tracked independently.
- Continues any active resumable source collection, or starts periodic collection when no editorial run is active.
- Runs one bounded raw-payload retention batch daily when higher-priority work is idle.

Database row locking and short leases prevent overlapping requests from duplicating work. Source checks and editorial steps can recover after interruption; digest runs can recover after fifteen minutes. A distribution request whose lease expires without a recorded provider response is marked uncertain and requires an explicit editor retry, because replaying it automatically could duplicate a post or campaign. The editorial workflow runs at 07:00 UK time by default, one hour before the current 08:00 publication window, and enforces the shared daily article target and estimated-cost limit.

The scheduled migration currently targets `https://conservation-news.vercel.app/api/automation/editorial`. Changing the production hostname requires reviewing this endpoint and the Vault configuration.

## External APIs

### OpenAI

Used server-side for:

- Source-item assessment and clustering
- Story research and web-search-supported research packs
- Structured article drafting
- Structured article and digest contextual-link planning
- Coverage analysis and conservation outlook
- Taxonomy suggestions and descriptions
- Course recommendations and contextual-link assessment
- Daily and weekly digest generation, including purpose-written social copy

All generated editorial prompts should include `AI_HOUSE_STYLE`. Estimated usage is stored with run and generation records.

### Unsplash

Used server-side to search for landscape editorial images. The application hotlinks transformed Unsplash URLs, stores creator/licence attribution, and calls the download endpoint when a selection is used. Articles and digests perform separate searches: a digest selects a new image for its overall editorial theme and excludes images attached to its source stories and recent digests. Digest heroes use the shared charcoal surface rather than image-derived colours.

### Brevo

`/api/newsletter/subscribe` validates an email address and adds or updates the contact in the configured Brevo list. A honeypot field provides basic bot filtering. When email distribution is enabled, a published Friday digest is rendered as a responsive Brevo marketing campaign with custom browser-view and unsubscribe links, created against the same list and submitted for sending. The subject uses `WildNews Weekly | [edition headline]`. The email uses a purpose-written, shortened editorial edition generated in the existing digest AI pass, the digest hero image, a second source-story image within the editorial copy, five recent source-story cards, a full-width WildTeam Training promotion and a link to the full web edition rather than reproducing the complete digest. Older editions without dedicated email copy fall back to their standfirst and shortened extracts from their first three sections. The provider campaign ID and delivery outcome are stored against the digest run. An authenticated editor can also send the exact rendered weekly email to one explicit test address from the digest preview. The application creates a recipient-free draft campaign, uses Brevo's test-send endpoint, deletes the draft and records an audit event without storing the test address or changing distribution status.

### Buffer

When social distribution is enabled, publication creates one durable `social-editorial` delivery rather than calling OpenAI or Buffer inside the already busy publication request. A later heartbeat supplies the final published digest, compact evidence from its published source stories and up to eight recent generated posts to a dedicated social editor. Daily editions select three or four developments and target roughly 120–180 words; weekly editions select four or five developments and target roughly 180–250 words with more synthesis and reflection. A separate AI editorial review checks grounding, qualifications, selection, readability, repetition and the relevance and tone of its restrained emoji use, and records paragraph-level claim-to-story support copied from the final post. Deterministic validation independently enforces source IDs, flexible safety length bounds, paragraph structure, one relevant opening emoji and no more than two optional body emojis, a non-generic and sufficiently distinct opening, two or three hashtags including `#WildNews`, absence of inappropriate reaction emojis, relative dates, unsupported Markdown, embedded URLs and em dashes, and one exact application-owned canonical digest link directly beneath the opening paragraph. Invalid or rejected copy never creates a channel delivery.

Validated text, selected story IDs, review diagnostics, prompt versions, token usage and estimated cost are retained in `digest_runs.social_copy`; each Buffer delivery also keeps the immutable exact payload it will submit. A retry of an interrupted social-editorial stage reuses already validated stored copy, so it cannot silently create different channel payloads. Each configured Buffer channel then receives the same image post through its own leased delivery record. Before submission, the server resolves the destination's Buffer service and adds required network-specific metadata, including the `post` content type for Facebook, while retaining the shared copy and image payload for LinkedIn. Editors choose between Buffer's `addToQueue` mode, which retains each channel's posting schedule, and `shareNow`, which publishes as soon as the delivery heartbeat processes the post. Each destination has its own attempt count and provider post ID, preserving the existing duplicate-prevention and uncertain-outcome safeguards. Buffer credentials remain server-only.

Automatic social delivery has a two-hour posting window measured from the edition's scheduled `period_end`, even after a delayed run. Pending or failed Buffer deliveries with no recorded submission expire as `unsent`, with an audit event. The worker checks the deadline before editorial generation, after generation and before provider submission; manual retries also enforce it. Accepted Buffer posts retain their queued state, uncertain provider outcomes retain duplicate-delivery safeguards, and weekly emails retain their existing policy. The database minute scheduler performs idle expiry without an extra Vercel invocation.

### Analytics

The public application uses the existing WildTeam Google Tag Manager container, `GTM-KW2PQNF`, which feeds the shared Google Analytics 4 property used by the main WildTeam and Training sites. On `news.wildteam.org.uk`, statistical analytics are enabled by default under the UK statistical-purposes exception. Consent Mode v2 keeps `ad_storage`, `ad_user_data` and `ad_personalization` denied for WildNews. Visitors receive a clear notice and may opt out free of charge; opting out disables the container on subsequent loads and removes existing Google Analytics cookies. Preview deployments, local development and authenticated admin routes are not tracked. The visitor's choice is stored locally in the browser and can be changed from the site footer.

Google Analytics owns outgoing `_gl` link decoration through the shared Google tag's **Configure your domains** setting. The previous **Contains** `wildteam.org.uk` condition also decorated Jobs links. Its replacement is **Matches RegEx** `^(?!jobs\.wildteam\.org\.uk$).*wildteam\.org\.uk.*$`, preserving the previous matches except the exact Jobs hostname. Jobs navigation must open `https://jobs.wildteam.org.uk/` without a linker parameter; other WildTeam destinations retain their existing linking. Keep this rule in the Google tag configuration, rather than adding a competing local `gtag('set', 'linker', ...)` override, which the shared tag overrides. Verify an actual navigation after refreshing the source page, because Google adds the parameter at click time.

Published stories and digests also send narrow first-party learning events through `/api/interactions`. The server validates that the content and any linked source or digest story are published before using the service role to write. Records contain an idempotency key, content relationships, event type and timestamp, but no IP address, account ID, user agent, referrer or persistent visitor identifier. Passive page-view, share and click events follow the existing analytics opt-out. Explicit usefulness feedback is still accepted after opt-out because it is a direct user action; the browser stores only the selected choice and its retry key. Authenticated editors can inspect aggregate 30-day content and source outcomes in `/admin/insights`.

The same Insights workspace reports seven-day workflow health and estimated AI cost plus internal Buffer and Brevo delivery outcomes. Provider engagement data is not inferred from submission status and will be added only when supported API fields are confirmed. Source recommendations remain advisory. `source_learning_policy` locks automatic changes off and records the initial evidence gate: 90 observation days, 20 reviewed recommendations, 10 decisions per rule and at least 80% acceptance. Passing the gate cannot enable automation without a later reviewed migration.

### Performance monitoring

Vercel Speed Insights records Core Web Vitals for public production pages only. Admin routes and preview deployments are excluded. Dynamic story, digest, topic and tag paths are grouped by route pattern so performance can be compared across each page type without exposing editorial slugs as separate route groups.

### Availability and automation health

`instrumentation.ts` records server render/route failures through Vinext's `onRequestError` hook. `lib/operational-log.ts` emits structured, allowlisted operation, route, duration, error-code, digest, deployment and correlation fields without raw errors, request bodies, headers, cookies or query strings. The public error boundary submits only its pathname and digest to the same-origin `/api/client-errors` endpoint, which limits body size and reports per instance. A bounded HEAD-request counter logs bursts for observation only; it never blocks visitors. Database error/slow-read logs and render failures are independent of analytics consent.

`/api/health` is the production monitoring endpoint. It returns no records or error details, but verifies that Supabase is reachable through the public published-story query as well as privileged automation checks, that the one-minute automation heartbeat is current, and that enabled editorial, publishing, digest and distribution systems have not recorded an unresolved automation failure. A detected public render failure marks public pages unhealthy until the affected path renders successfully or the ten-minute failure marker expires. A failed or uncertain delivery makes enabled distribution unhealthy until an editor resolves or retries it. A required heartbeat older than ten minutes makes the endpoint return HTTP 503; a healthy or intentionally disabled system returns HTTP 200. The endpoint is uncached and excluded from search indexing so an external uptime service can use its HTTP status for alerts without receiving private operational data. Monitoring should additionally GET the homepage and a story and verify expected rendered content, rather than treating any HTTP 200 as proof of successful rendering.

### Backup and recovery

While the Supabase project remains on the Free plan, `.github/workflows/supabase-backup.yml` creates an encrypted logical database backup every day at 03:30 UTC and supports manual runs. The workflow uses the official Supabase CLI, verifies the encrypted archive before upload, and retains the encrypted GitHub Actions artifact for 30 days. Production records are never committed to the repository.

The workflow depends on the GitHub Actions secrets `SUPABASE_DB_URL`, `SUPABASE_DB_PASSWORD` and `BACKUP_ENCRYPTION_PASSPHRASE`. The database address and password remain separate so passwords containing URL-sensitive characters do not make the connection URI invalid, and the assembled backup connection explicitly requires SSL. They are repository automation secrets, not application runtime variables, and do not belong in `.env.example` or Vercel. The operational scope, exclusions, integrity check and safe recovery sequence are documented in `docs/BACKUP_RECOVERY.md`.

Logical database backups do not contain Supabase Storage object bytes, a separate Supabase migration-history schema or external-platform configuration. The ordered files in `supabase/migrations` remain the migration source of truth. Storage currently contains admin avatars; service credentials and configuration remain the responsibility of their owning platforms and secure organisational password storage. If Supabase is upgraded to a paid production plan, Supabase-managed daily backups should become the primary recovery mechanism and this workflow should be reassessed rather than silently duplicated.

`/api/health/supabase` remains a narrower database-connectivity diagnostic. Vercel provides deployment-failure notifications and runtime logs on the current plan. Automated Vercel runtime-anomaly alerts require a paid Observability tier, so external monitoring of `/api/health` supplies the proactive availability alert.

## Environment variables

Only names and purposes belong in source control.

| Name | Exposure | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Supabase publishable/anon access |
| `SUPABASE_URL` | Server only | Supabase URL used by the service-role client |
| `SUPABASE_SECRET_KEY` | Server only | Supabase service-role secret |
| `OPENAI_API_KEY` | Server only | OpenAI assessment, research and generation |
| `UNSPLASH_ACCESS_KEY` | Server only | Unsplash public image API |
| `BREVO_API_KEY` | Server only | Brevo contact API |
| `BREVO_LIST_ID` | Server configuration | Weekly Digest contact-list identifier |
| `BREVO_SENDER_ID` | Server configuration | Verified Brevo sender used for Weekly Digest campaigns |
| `BUFFER_API_KEY` | Server only | Buffer GraphQL API authentication |
| `BUFFER_CHANNEL_IDS` | Server configuration | Comma-separated Buffer channels that receive published digests |
| `AUTOMATION_SECRET` | Server only | Bearer secret for the scheduled automation endpoint |
| `VERCEL_ENV` | Platform supplied | Distinguishes production from preview for indexing |
| `VERCEL` | Platform supplied | Enables Vercel CDN tag deletion after public editorial mutations |
| `VERCEL_DEPLOYMENT_ID` | Platform supplied | Separates cached HTML by deployment and identifies structured errors |
| `VERCEL_URL` | Platform supplied | Cache deployment identity fallback when the deployment ID is unavailable |
| `NODE_ENV` | Platform supplied | Runtime mode fallback |
| `CODEX_SANDBOX` | Local tooling | Enables polling for local sandbox HMR |

`.env.example` contains the user-configured variables required by the application. Platform-provided and local-tooling variables are documented here but do not require manual values in the example file.

## Assets and metadata

- Fonts: `public/fonts/`
- WildTeam favicon and Good News mask: `public/favicon.png`
- WildTeam logo used in schema: `public/wildteam-logo.png`
- Default social image: `public/og.png`
- Dynamic editorial images: remote Unsplash URLs with stored attribution

`app/layout.tsx` defines default metadata. `lib/seo.ts` centralises canonical URLs, Open Graph/Twitter values and Schema.org objects. Story and digest routes emit `NewsArticle`; the root emits `WebSite` and `Organization`.

`app/sitemap.ts` derives public URLs from current published content and taxonomy. `app/llms.txt/route.ts` derives its latest stories, digests, topics and approved tags from the same data.

The default social image is a 1200×630 WildNews-branded graphic. Public metadata uses the intended canonical domain and falls back to this image when a story-specific image is unavailable.

## Legacy Sites remnants

The repository began from a ChatGPT Sites-oriented starter. Its Sites hosting manifest, Vite plugin, plugin configuration, package name, SVG favicon and unused Cloudflare-oriented package allowances were removed during pre-launch cleanup. The application does not use Sites authentication, connectors, D1, R2 or deployment.

Vinext, Vite and Nitro remain active framework dependencies and produce the Vercel deployment.

## Verification

Normal code verification:

```text
pnpm exec tsc --noEmit
pnpm exec oxlint <changed files>
git diff --check
pnpm build
```

Publishing regression checks run with `pnpm test:publishing`. They exercise lease renewal and stale-worker rejection, the real database migration in a local PGlite Postgres instance, duplicate shortlist prevention, replacement capacity, the tenth publication claim, rollover expiry, access restrictions, budget-stop handoff and retry, and the real digest query's exclusive reporting-period boundary. No production credentials or writes are used.

Availability regression checks additionally run `node --experimental-strip-types --test tests/public-page-cache.test.ts`. After building, run `node --env-file=.env.local scripts/verify-public-availability.mjs` with the two browser-safe Supabase variables configured. The integration check starts a local public-data proxy and production build, injects query failures, exercises warm and cold request bursts, and tests authenticated withdrawal against an in-memory fixture. It rejects every upstream production write and uses no real admin credentials. It requires local ports 3101 and 3102. Temporary rendered HTML and sanitized server logs are written under `/tmp/wildnews-*` for inspection.

Deployment verification must additionally cover Supabase connectivity, admin authentication, the automation heartbeat, collection, draft creation, queue publication, digest generation, newsletter signup, public metadata, structured data, sitemap, robots and `llms.txt`.

