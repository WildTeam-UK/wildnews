// Dry-run by default. See docs/PUBLISHING_RECOVERY.md before using --apply-outside-window.
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { publicationChecks } from '@/lib/publishing';
import { publishClaimedQueueItem, queueReadyDrafts } from '@/lib/publication-queue';
import { candidateRankingSettings, compareRankedCandidates, rankCandidate } from '@/lib/candidate-ranking';
import { isSameLondonDay, londonDateTimeParts, londonLocalDateTimeToUtc } from '@/lib/london-time';
import type { StoryDraftContent } from '@/lib/openai/draft-story';
import { isUuid } from '@/lib/validation';

async function main() {
  const args = process.argv.slice(2);
  const runId = args.find((arg) => arg.startsWith('--run-id='))?.slice('--run-id='.length);
  const apply = args.includes('--apply-outside-window');
  if (!isUuid(runId)) throw new Error('Supply --run-id=<UUID>. The default is a read-only recovery preview.');
  if (args.some((arg) => !arg.startsWith('--run-id=') && arg !== '--apply-outside-window')) throw new Error('Unknown recovery option.');
  const supabase = getSupabaseAdminClient();
  const [{ data: settings, error: settingsError }, { data: run, error: runError }, { data: items, error: itemsError }] = await Promise.all([
    supabase.from('editorial_run_settings').select('*').eq('id', true).single(),
    supabase.from('editorial_runs').select('started_at, status').eq('id', runId).single(),
    supabase.from('editorial_run_items').select('story_id').eq('run_id', runId).eq('status', 'drafted').not('story_id', 'is', null),
  ]);
  if (settingsError || runError || itemsError) throw new Error('Recovery could not read the run and its settings.');
  if (!isSameLondonDay(new Date(run.started_at), new Date())) throw new Error('Recovery is limited to the original London day. Do not move an old run into fresh daily capacity.');
  if (run.status === 'running') throw new Error('Wait for the active run to stop before recovering its publications.');
  if (!settings.auto_publish_enabled) throw new Error('Automatic publication is paused.');
  const now = new Date();
  const local = londonDateTimeParts(now);
  const dayStart = new Date(londonLocalDateTimeToUtc(local.year, local.month, local.day)).toISOString();
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const dayEnd = new Date(londonLocalDateTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())).toISOString();
  const localTime = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:${String(local.second).padStart(2, '0')}`;
  const outsideWindow = localTime < settings.publish_window_start || localTime >= settings.publish_window_end;
  if (apply && !outsideWindow) throw new Error('Use the ordinary checked schedule while the publishing window is open.');
  const [{ data: stories, error: storiesError }, { data: published, error: publishedError }, { data: publishing, error: publishingError }] = await Promise.all([
    supabase.from('stories').select('id, headline, cluster_id, status, generation_metadata, taxonomy_review_required, taxonomy_review_reason')
      .in('id', (items ?? []).map((item) => item.story_id)).eq('status', 'draft').eq('content_type', 'news'),
    supabase.from('stories').select('id').eq('status', 'published').eq('content_type', 'news').gte('published_at', dayStart).lt('published_at', dayEnd),
    supabase.from('publication_queue').select('story_id').eq('status', 'publishing'),
  ]);
  if (storiesError || publishedError || publishingError) throw new Error('Recovery could not verify private drafts and daily publication capacity.');
  if (publishing?.length) throw new Error('A publication is in progress. Wait for it to finish before recovery.');
  const [{ data: clusters, error: clusterError }, { data: sources, error: sourceError }, { data: queue, error: queueError }] = await Promise.all([
    supabase.from('story_clusters').select('id, overall_score, evidence_score, relevance_score, assessment, created_at, last_source_at').in('id', (stories ?? []).map((story) => story.cluster_id)),
    supabase.from('story_sources').select('story_id').in('story_id', (stories ?? []).map((story) => story.id)),
    supabase.from('publication_queue').select('story_id, status, attempt_count').in('story_id', (stories ?? []).map((story) => story.id)),
  ]);
  if (clusterError || sourceError || queueError) throw new Error('Recovery could not verify assessment scores, linked sources and queue state.');
  const rankingSettings = candidateRankingSettings(settings);
  const preview = (stories ?? []).map((story) => {
    const content = (story.generation_metadata as { article_content?: StoryDraftContent } | null)?.article_content;
    const sourceCount = (sources ?? []).filter((source) => source.story_id === story.id).length;
    const cluster = (clusters ?? []).find((candidate) => candidate.id === story.cluster_id);
    const ranking = cluster ? rankCandidate(cluster, rankingSettings) : null;
    const reasons = content ? publicationChecks(content, sourceCount).filter((check) => !check.passed).map((check) => check.label) : ['Article content is missing.'];
    if (story.taxonomy_review_required) reasons.push(story.taxonomy_review_reason || 'Topic classification needs review.');
    if (sourceCount < 3) reasons.push('At least three linked sources are required.');
    if (!cluster || Number(cluster.overall_score ?? 0) < settings.min_auto_publish_overall_score) reasons.push('Overall score is below the automatic threshold.');
    if (!cluster || Number(cluster.evidence_score ?? 0) < settings.min_auto_publish_evidence_score) reasons.push('Evidence score is below the automatic threshold.');
    if (!ranking?.isFresh) reasons.push('Supporting reporting is no longer fresh.');
    if (queue?.some((item) => item.story_id === story.id && ['cancelled', 'held'].includes(item.status))) reasons.push('An editor must review the existing queue hold or cancellation.');
    if (queue?.some((item) => item.story_id === story.id && item.attempt_count > 0)) reasons.push('An earlier publication attempt needs review through the existing retry controls.');
    return { id: story.id, headline: story.headline, sources: sourceCount, cluster, ranking, reasons };
  });
  const capacity = Math.max(0, Math.min(10, Number(settings.max_new_drafts)) - (published?.length ?? 0));
  const selected = preview.filter((story) => !story.reasons.length && story.ranking).sort((a, b) => compareRankedCandidates({ ...a.cluster!, ranking: a.ranking! }, { ...b.cluster!, ranking: b.ranking! })).slice(0, capacity);
  console.log(JSON.stringify({ mode: apply ? 'approved_outside_window_recovery' : 'read_only_preview', runId, checkedAt: now.toISOString(), outsideWindow, dailyLimit: Math.min(10, Number(settings.max_new_drafts)), publishedToday: published?.length ?? 0, privateDrafts: stories?.length ?? 0, eligible: preview.filter((story) => !story.reasons.length).length, selected: selected.map(({ ranking, reasons: _reasons, cluster: _cluster, ...story }) => ({ ...story, effectiveScore: ranking?.effectiveScore })), held: preview.filter((story) => story.reasons.length).map(({ ranking: _ranking, cluster: _cluster, ...story }) => story), remainingPrivate: (stories?.length ?? 0) - selected.length }, null, 2));
  if (!apply) return;
  // This explicit one-off operation changes timing only. Queue admission and
  // the ordinary final publisher both retain their complete existing checks.
  for (const story of selected) {
    const { count, error: capacityError } = await supabase.from('stories').select('id', { count: 'exact', head: true }).eq('status', 'published').eq('content_type', 'news').gte('published_at', dayStart).lt('published_at', dayEnd);
    if (capacityError || Number(count ?? 0) >= Math.min(10, Number(settings.max_new_drafts))) throw new Error('Daily capacity changed. Stop and refresh the recovery preview.');
    if (!isSameLondonDay(now, new Date())) throw new Error('The London day ended. Stop recovery.');
    await queueReadyDrafts(runId, story.id, false);
    const { data: claimed, error: claimError } = await supabase.from('publication_queue')
      .update({ status: 'publishing', claimed_at: new Date().toISOString(), attempt_count: 1 })
      .eq('story_id', story.id).eq('attempt_count', 0).in('status', ['queued', 'scheduled']).select('id').maybeSingle();
    if (claimError || !claimed) throw new Error('The draft did not pass queue admission or its queue state changed. Stop recovery.');
    const result = await publishClaimedQueueItem(claimed.id);
    console.log(JSON.stringify({ storyId: story.id, action: result.action }));
    if (!['published', 'published_with_queue_warning', 'already_published'].includes(result.action)) throw new Error('The ordinary publisher did not publish the article. Stop recovery and review its queue record.');
    await supabase.from('editorial_run_events').insert({ run_id: runId, stage: 'publishing', message: 'Article recovered outside the ordinary publishing window with explicit editor authorization. The daily limit and publication checks were preserved.', details: { story_id: story.id, queue_id: claimed.id } });
  }
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Editorial publication recovery failed.'); process.exitCode = 1; });
