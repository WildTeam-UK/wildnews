# Publishing recovery

Normal automation uses the configured London publication window and daily article target. Surplus or stale drafts do not automatically roll forward. A digest uses only published news in its explicit reporting period, never yesterday's digest or an older fallback selection. Too few eligible stories stops digest generation rather than creating a repeat edition.

## 11 November 2026 incident

The 07:00 run selected two shortlists of ten, produced 18 private drafts, and stopped at 07:43 with an estimated $0.964747 spent against a $1 limit. The budget-stop path did not hand off its completed drafts. The digest published at 09:00 using the preceding reporting period. No news article published on 11 November as of the recovery preview at 21:30 UK time.

A read-only live database snapshot was evaluated by the recovery script's existing `publicationChecks`, taxonomy, score, three-source and freshness safeguards. All 18 drafts passed. Ranking by the existing effective candidate score selects these ten for recovery, leaving eight private:

| Article | Effective score | Sources |
| --- | ---: | ---: |
| Study finds declining site use by four mammals in Cambodia’s mangroves | 85 | 3 |
| Sea-level rise could inundate mapped habitat for up to 15,324 vertebrate species | 84 | 3 |
| Conservationists move 3,400 rare wintergreens from eroding shore at Culbin | 84 | 4 |
| US seabed applications and licences could cover half of Pacific mining zone | 82 | 6 |
| Study finds satellite maps only modestly match field measurements of change in Great Basin rangelands | 82 | 4 |
| Scotland’s rainforest programme wins £5.98m grant | 81 | 4 |
| Study links chytrid fungus to frog declines at one Brazilian site | 78 | 4 |
| New passage offers salmon a more permanent route at Okanagan Lake | 77 | 5 |
| Kolwezi residents sue COMMUS over alleged mining pollution | 77 | 6 |
| The Conservation Fund buys Carter family farm in Georgia | 77 | 3 |

Publishing these ten before midnight London time would count against 11 November's ten-article allowance and supply new evidence for the 12 November digest's 09:00-to-09:00 window. The 12 November run would retain its own fresh daily capacity. This is an explicit exception to publication timing, not to article limits or editorial checks. It requires editor authorization before execution. If midnight passes, stop and reassess; do not replay this plan into another day's capacity or fabricate an edition.

## Completed recovery

The user authorized the production rollout and outside-window recovery. The migration was applied as version `20261111214122`. Production deployment `dpl_9Rkt2XSKXTB19sYB2tstTgGxYVmr` was built from the existing production commit `8d14585` plus only the reviewed publishing changes, preserving unrelated local edits and the current production navigation.

Before recovery, a fresh count found that the USGS public-land research briefing had already been published at 19:14. To keep the day at ten news articles, the first nine articles in the preview table were published through the authenticated admin publishing controls between 23:10 and 23:16. The Carter farm article and the other eight surplus drafts remain private. Their nine unused queue entries were cancelled, preserving the articles and making any later publication an explicit editorial decision.

The final live query verified ten news articles published on 11 November, ten published stories eligible for the 12 November 09:00 digest, and zero overlap with the source stories used in the 11 November digest. The 07:00 daily run time, ten-article target and existing publication safeguards remain in place. The heartbeat reported no automation error. This verifies the next edition's source availability; the future generation and distribution have not yet occurred.

The final release, `dpl_12jDjCtxuUg7NSpDaLpm58braZaD`, also corrects manual budget resumption: reopening a run clears its handoff marker, and already queued or published drafts from that run are counted once against its target. All 21 publishing regression tests pass. Production reported a current heartbeat, no automation error and zero unresolved handoffs after that release became ready.

## Procedure

1. Review and apply the ordered `20261111214122_editorial_publication_safety.sql` migration before deploying the corresponding application changes. Deploy only the reviewed publishing changes and preserve unrelated work in the checkout. Its filename matches the migration version recorded by Supabase when applied on 11 November.
2. Run `pnpm test:publishing`, TypeScript, lint, diff checks and the production build. Verify the live heartbeat after deployment.
3. Obtain runtime credentials through the established secure server configuration. Never print or commit their values. The recovery script accepts the existing server environment names only.
4. Bundle the operational script and run its default read-only preview with the desired run ID. For example, with an existing private local environment file:

   ```sh
   pnpm exec esbuild scripts/recover-editorial-publication.ts --bundle --platform=node --format=cjs --outfile=/tmp/wildnews-recover-editorial-publication.cjs
   node --env-file=.env.local /tmp/wildnews-recover-editorial-publication.cjs --run-id=3afe8e9e-8527-4904-93e8-5d29b474c914
   ```

5. Review the preview. It refuses a previous-day run, an active run, paused publication or an in-progress publication. It checks the full content checklist, taxonomy review, source count, assessment thresholds and current freshness. It excludes existing holds and cancellations, then selects at most the remaining ten-article capacity.
6. Only after explicit authorization for the outside-window recovery, rerun the same command with `--apply-outside-window`. The script rechecks current state, admits each selected draft through `queueReadyDrafts`, claims it once and calls `publishClaimedQueueItem`. The final publication checklist and score/source safeguards run again. Each successful publication uses the normal cache invalidation and audit path. A non-publication result stops the recovery for review; it does not force an override.
7. Verify actual published news counts, queue outcomes, public article pages and the next digest's eligible source-story count. The remaining eight drafts stay private. Never increase the daily target, backdate publication, delete editorial history or widen the digest's reporting period to conceal a failed day.

The script defaults to read-only preview. An apply command is limited to the original London day and is deliberately refused during the ordinary publication window, when the established scheduler should be used instead. Run only one recovery process at a time.
