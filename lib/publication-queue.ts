import type { StoryDraftContent } from '@/lib/openai/draft-story';
import { stripSourceMarkers } from '@/lib/article-text';
import { publicationChecks } from '@/lib/publishing';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { runTaxonomyGovernance } from '@/lib/taxonomy-governance';
import { londonDateTimeParts, londonLocalDateTimeToUtc } from '@/lib/london-time';
import { planSameDayPublicationTimes, remainingDailyArticleCapacity } from '@/lib/publication-planning';
import { invalidatePublicPages } from '@/lib/invalidate-public-pages';

export class PublicationQueueConflict extends Error {}

const MINIMUM_AUTOMATIC_SOURCES = 3;

type PublicationSettings = {
  auto_publish_enabled: boolean;
  publish_window_start: string;
  publish_window_end: string;
  max_new_drafts: number;
  min_auto_publish_overall_score: number;
  min_auto_publish_evidence_score: number;
};

type QueueRow = {
  id: string;
  story_id: string;
  status: 'queued' | 'scheduled' | 'publishing' | 'published' | 'held' | 'cancelled';
  priority_rank: number | null;
  scheduled_for: string | null;
  attempt_count: number;
  editor_approved_at?: string | null;
  created_at: string;
};

function timeParts(value: string) {
  const [hour, minute] = value.slice(0, 5).split(':').map(Number);
  return { hour, minute };
}

function localDateKey(date: Date) {
  const parts = londonDateTimeParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function londonDayBounds(date: Date) {
  const local = londonDateTimeParts(date);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return {
    start: londonLocalDateTimeToUtc(local.year, local.month, local.day),
    end: londonLocalDateTimeToUtc(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, nextDate.getUTCDate()),
    local,
  };
}

async function getSettings(): Promise<PublicationSettings> {
  const { data, error } = await getSupabaseAdminClient()
    .from('editorial_run_settings')
    .select('auto_publish_enabled, publish_window_start, publish_window_end, max_new_drafts, min_auto_publish_overall_score, min_auto_publish_evidence_score')
    .eq('id', true)
    .single();
  if (error || !data) throw error ?? new Error('Publication settings were not found.');
  return data as PublicationSettings;
}

type RebalanceOptions = {
  sourceRunId?: string | null;
  storyId?: string | null;
};

export async function remainingPublicationCapacityToday(target: number) {
  const supabase = getSupabaseAdminClient();
  const bounds = londonDayBounds(new Date());
  const { count, error } = await supabase
    .from('publication_queue')
    .select('id', { count: 'exact', head: true })
    .in('status', ['scheduled', 'publishing', 'published'])
    .gte('scheduled_for', new Date(bounds.start).toISOString())
    .lt('scheduled_for', new Date(bounds.end).toISOString());
  if (error) throw error;
  return remainingDailyArticleCapacity(target, Number(count ?? 0));
}

export async function rebalancePublicationQueue(options: RebalanceOptions = {}) {
  const supabase = getSupabaseAdminClient();
  const settings = await getSettings();
  if (!settings.auto_publish_enabled) return { scheduled: 0 };

  const now = new Date();
  const bounds = londonDayBounds(now);
  const dayStart = new Date(bounds.start).toISOString();
  const dayEnd = new Date(bounds.end).toISOString();
  const protectedUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  let movableQuery = supabase
    .from('publication_queue')
    .select('id, scheduled_for')
    .eq('status', 'scheduled')
    .gte('scheduled_for', dayStart)
    .lt('scheduled_for', dayEnd);
  if (options.sourceRunId) movableQuery = movableQuery.eq('source_run_id', options.sourceRunId);
  else if (options.storyId) movableQuery = movableQuery.eq('story_id', options.storyId);
  const { data: movable, error: movableError } = await movableQuery;
  if (movableError) throw movableError;
  const movableIds = (movable ?? [])
    .filter((row) => !row.scheduled_for || row.scheduled_for < now.toISOString() || row.scheduled_for > protectedUntil)
    .map((row) => row.id);
  if (movableIds.length) {
    const { error } = await supabase.from('publication_queue').update({ status: 'queued', scheduled_for: null }).in('id', movableIds);
    if (error) throw error;
  }

  let pendingQuery = supabase.from('publication_queue').select('id, story_id, status, priority_rank, scheduled_for, attempt_count, created_at').eq('status', 'queued').order('priority_rank', { ascending: true, nullsFirst: false }).order('created_at');
  if (options.sourceRunId) pendingQuery = pendingQuery.eq('source_run_id', options.sourceRunId);
  else if (options.storyId) pendingQuery = pendingQuery.eq('story_id', options.storyId);
  else if (movableIds.length) pendingQuery = pendingQuery.in('id', movableIds);
  else return { scheduled: 0 };

  const [{ data: pending, error: pendingError }, { data: fixed, error: fixedError }] = await Promise.all([
    pendingQuery,
    supabase.from('publication_queue').select('id, story_id, status, priority_rank, scheduled_for, attempt_count, created_at').in('status', ['scheduled', 'publishing', 'published']).gte('scheduled_for', dayStart).lt('scheduled_for', dayEnd),
  ]);
  if (pendingError) throw pendingError;
  if (fixedError) throw fixedError;
  const queue = (pending ?? []) as QueueRow[];
  if (!queue.length) return { scheduled: 0 };

  const startTime = timeParts(settings.publish_window_start);
  const endTime = timeParts(settings.publish_window_end);
  const date = bounds.local;
  const key = localDateKey(now);
  const start = londonLocalDateTimeToUtc(date.year, date.month, date.day, startTime.hour, startTime.minute);
  const end = londonLocalDateTimeToUtc(date.year, date.month, date.day, endTime.hour, endTime.minute);
  const scheduledTimes = planSameDayPublicationTimes({
    storyIds: queue.map((row) => row.story_id),
    dateKey: key,
    now: now.getTime(),
    windowStart: start,
    windowEnd: end,
    target: settings.max_new_drafts,
    occupied: fixed?.length ?? 0,
  });
  const updates = queue.slice(0, scheduledTimes.length).map((row, index) => {
    const scheduledFor = scheduledTimes[index];
    return supabase.from('publication_queue').update({ status: 'scheduled', scheduled_for: scheduledFor, hold_reason: null, last_error: null }).eq('id', row.id);
  });
  const results = await Promise.all(updates);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  return { scheduled: scheduledTimes.length };
}

export async function queueReadyDrafts(sourceRunId: string | null = null, onlyStoryId: string | null = null, forceRebalance = true, allowCancelled = false, allowWhenPaused = false, resetEditorApproval = false) {
  const supabase = getSupabaseAdminClient();
  const settings = await getSettings();
  if (!settings.auto_publish_enabled && !allowWhenPaused) return { queued: 0, held: 0, scheduled: 0 };

  const { data: runItems, error: runItemsError } = sourceRunId
    ? await supabase.from('editorial_run_items').select('story_id, rank').eq('run_id', sourceRunId).not('story_id', 'is', null)
    : { data: [], error: null };
  if (runItemsError) throw runItemsError;
  const runStoryIds = (runItems ?? []).flatMap((item) => item.story_id ? [item.story_id] : []);
  if (sourceRunId && !runStoryIds.length) return { queued: 0, held: 0, scheduled: 0 };

  let storyQuery = supabase
    .from('stories')
    .select('id, cluster_id, generation_metadata, taxonomy_review_required, taxonomy_review_reason, created_at')
    .eq('status', 'draft')
    .order('created_at');
  if (onlyStoryId) storyQuery = storyQuery.eq('id', onlyStoryId);
  else if (sourceRunId) storyQuery = storyQuery.in('id', runStoryIds);
  const { data: stories, error: storiesError } = await storyQuery;
  if (storiesError) throw storiesError;
  if (!stories?.length) return { queued: 0, held: 0, scheduled: 0 };

  const storyIds = stories.map((story) => story.id);
  const clusterIds = [...new Set(stories.flatMap((story) => story.cluster_id ? [story.cluster_id] : []))];
  const [{ data: existing, error: existingError }, { data: sources, error: sourcesError }, { data: clusters, error: clustersError }] = await Promise.all([
    supabase.from('publication_queue').select('story_id, status, editor_approved_at, editor_approved_by').in('story_id', storyIds),
    supabase.from('story_sources').select('story_id').in('story_id', storyIds),
    clusterIds.length ? supabase.from('story_clusters').select('id, overall_score, evidence_score').in('id', clusterIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (existingError) throw existingError;
  if (sourcesError) throw sourcesError;
  if (clustersError) throw clustersError;

  const existingByStory = new Map((existing ?? []).map((row) => [row.story_id, row]));
  const sourceCounts = new Map<string, number>();
  for (const source of sources ?? []) sourceCounts.set(source.story_id, (sourceCounts.get(source.story_id) ?? 0) + 1);
  const scores = new Map((clusters ?? []).map((cluster) => [cluster.id, cluster]));
  const runRanks = new Map((runItems ?? []).flatMap((item) => item.story_id ? [[item.story_id, item.rank] as const] : []));
  let queued = 0;
  let held = 0;
  let membershipChanged = false;

  for (const story of stories) {
    const existingQueue = existingByStory.get(story.id);
    const existingStatus = existingQueue?.status;
    const editorApproved = Boolean(existingQueue?.editor_approved_at) && !resetEditorApproval;
    if (existingStatus && ['publishing', 'published'].includes(existingStatus)) continue;
    if (existingStatus === 'cancelled' && !allowCancelled) continue;
    const metadata = (story.generation_metadata ?? {}) as Record<string, unknown> & { article_content?: StoryDraftContent };
    let content = metadata.article_content;
    if (content) {
      const headline = stripSourceMarkers(content.headline);
      const standfirst = stripSourceMarkers(content.standfirst);
      const seoTitle = stripSourceMarkers(content.seo_title);
      if (headline !== content.headline || standfirst !== content.standfirst || seoTitle !== content.seo_title) {
        content = { ...content, headline, standfirst, seo_title: seoTitle };
        const { error: cleanError } = await supabase.from('stories').update({ headline, standfirst, generation_metadata: { ...metadata, article_content: content } }).eq('id', story.id).eq('status', 'draft');
        if (cleanError) throw cleanError;
      }
    }
    const sourceCount = sourceCounts.get(story.id) ?? 0;
    const cluster = story.cluster_id ? scores.get(story.cluster_id) : null;
    const reasons: string[] = [];
    if (story.taxonomy_review_required) reasons.push(story.taxonomy_review_reason || 'Topic classification needs editorial review.');
    if (!content) reasons.push('Article content could not be verified.');
    else reasons.push(...publicationChecks(content, sourceCount).filter((check) => !check.passed).map((check) => check.label));
    if (!editorApproved && sourceCount < MINIMUM_AUTOMATIC_SOURCES) reasons.push(`Automatic publishing requires at least ${MINIMUM_AUTOMATIC_SOURCES} sources.`);
    if (!editorApproved && (!cluster || Number(cluster.overall_score ?? 0) < settings.min_auto_publish_overall_score)) reasons.push(`Overall score is below ${settings.min_auto_publish_overall_score}.`);
    if (!editorApproved && (!cluster || Number(cluster.evidence_score ?? 0) < settings.min_auto_publish_evidence_score)) reasons.push(`Evidence score is below ${settings.min_auto_publish_evidence_score}.`);

    const status = reasons.length ? 'held' : existingStatus === 'scheduled' ? 'scheduled' : 'queued';
    const priorityRank = ['held', 'cancelled'].includes(existingStatus ?? '') && status === 'queued'
      ? 1_000_000
      : runRanks.get(story.id) ?? (cluster ? 1000 - Number(cluster.overall_score ?? 0) : 2000);
    if (existingStatus === 'scheduled' && status === 'scheduled') continue;
    const { error } = await supabase.from('publication_queue').upsert({
      story_id: story.id,
      source_run_id: runRanks.has(story.id) ? sourceRunId : null,
      status,
      priority_rank: priorityRank,
      scheduled_for: null,
      hold_reason: reasons.join(' ' ) || null,
      last_error: null,
      editor_approved_at: editorApproved ? existingQueue?.editor_approved_at : null,
      editor_approved_by: editorApproved ? existingQueue?.editor_approved_by : null,
    }, { onConflict: 'story_id' });
    if (error) throw error;
    membershipChanged = membershipChanged || existingStatus !== status || status === 'queued';
    if (status === 'queued') queued += 1;
    else held += 1;
  }

  const scheduled = forceRebalance || membershipChanged ? await rebalancePublicationQueue({ sourceRunId, storyId: onlyStoryId }) : { scheduled: 0 };
  return { queued, held, scheduled: scheduled.scheduled };
}

export async function restoreDraftToQueue(storyId: string) {
  const supabase = getSupabaseAdminClient();
  const { data: story, error: storyError } = await supabase.from('stories').select('id, status').eq('id', storyId).maybeSingle();
  if (storyError) throw storyError;
  if (!story || story.status !== 'draft') throw new PublicationQueueConflict('Only a private draft can be added to the publishing queue.');

  await queueReadyDrafts(null, storyId, true, true, true);
  const { data: queueItem, error: queueError } = await supabase
    .from('publication_queue')
    .select('id, status, scheduled_for, hold_reason')
    .eq('story_id', storyId)
    .maybeSingle();
  if (queueError) throw queueError;
  if (!queueItem) throw new PublicationQueueConflict('The draft could not be added to the publishing queue.');
  return queueItem;
}

export async function approveHeldDraftForQueue(storyId: string, userId: string) {
  const supabase = getSupabaseAdminClient();
  const { data: story, error: storyError } = await supabase.from('stories').select('id, status').eq('id', storyId).maybeSingle();
  if (storyError) throw storyError;
  if (!story || story.status !== 'draft') throw new PublicationQueueConflict('Only a private draft can be added to the publishing queue.');

  const { data: approved, error: approvalError } = await supabase
    .from('publication_queue')
    .update({ editor_approved_at: new Date().toISOString(), editor_approved_by: userId })
    .eq('story_id', storyId)
    .eq('status', 'held')
    .select('id')
    .maybeSingle();
  if (approvalError) throw approvalError;
  if (!approved) throw new PublicationQueueConflict('This article is no longer held for review. Refresh the page and check its current queue status.');

  await queueReadyDrafts(null, storyId, false, false, true);
  const { data: queueItem, error: queueError } = await supabase
    .from('publication_queue')
    .select('id, status, scheduled_for, hold_reason')
    .eq('story_id', storyId)
    .single();
  if (queueError) throw queueError;
  if (queueItem.status === 'held') {
    await supabase.from('publication_queue').update({ editor_approved_at: null, editor_approved_by: null }).eq('id', queueItem.id);
    throw new PublicationQueueConflict(`This article still needs changes before it can be queued: ${queueItem.hold_reason || 'complete the editorial review and save the draft.'}`);
  }
  await rebalancePublicationQueue({ storyId });
  return queueItem;
}

export async function cancelQueuedPublication(queueId: string) {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('publication_queue')
    .update({ status: 'cancelled', scheduled_for: null, claimed_at: null, hold_reason: 'Removed from the automatic publishing queue by an editor.', editor_approved_at: null, editor_approved_by: null })
    .eq('id', queueId)
    .in('status', ['queued', 'scheduled', 'held'])
    .select('id, story_id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PublicationQueueConflict('This article is no longer removable from the queue.');
  const result = await rebalancePublicationQueue();
  return { removed: true, storyId: data.story_id, rescheduled: result.scheduled };
}

export async function publishClaimedQueueItem(queueId: string) {
  const supabase = getSupabaseAdminClient();
  const [{ data: queueItem, error: queueError }, settings] = await Promise.all([
    supabase.from('publication_queue').select('id, story_id, attempt_count, editor_approved_at').eq('id', queueId).eq('status', 'publishing').single(),
    getSettings(),
  ]);
  if (queueError || !queueItem) throw queueError ?? new Error('Claimed publication was not found.');

  try {
    const [{ data: story, error: storyError }, { count: sourceCount, error: sourceError }] = await Promise.all([
      supabase.from('stories').select('id, status, cluster_id, headline, published_at, generation_metadata').eq('id', queueItem.story_id).single(),
      supabase.from('story_sources').select('*', { count: 'exact', head: true }).eq('story_id', queueItem.story_id),
    ]);
    if (storyError || !story) throw storyError ?? new Error('Queued article was not found.');
    if (sourceError) throw sourceError;
    if (story.status === 'published') {
      await invalidatePublicPages();
      await supabase.from('publication_queue').update({ status: 'published', published_at: story.published_at ?? new Date().toISOString(), claimed_at: null, hold_reason: null }).eq('id', queueId);
      return { action: 'already_published', storyId: story.id, headline: story.headline };
    }
    if (story.status !== 'draft') throw new Error('The queued article is no longer a private draft.');
    const content = (story.generation_metadata as { article_content?: StoryDraftContent } | null)?.article_content;
    if (!content) throw new Error('Article content could not be verified.');
    const failed = publicationChecks(content, sourceCount ?? 0).filter((check) => !check.passed).map((check) => check.label);
    const editorApproved = Boolean(queueItem.editor_approved_at);
    if (!editorApproved && (sourceCount ?? 0) < MINIMUM_AUTOMATIC_SOURCES) failed.push(`At least ${MINIMUM_AUTOMATIC_SOURCES} sources are required`);
    if (!editorApproved && story.cluster_id) {
      const { data: cluster, error } = await supabase.from('story_clusters').select('overall_score, evidence_score').eq('id', story.cluster_id).single();
      if (error) throw error;
      if (Number(cluster.overall_score ?? 0) < settings.min_auto_publish_overall_score) failed.push(`Overall score is below ${settings.min_auto_publish_overall_score}`);
      if (Number(cluster.evidence_score ?? 0) < settings.min_auto_publish_evidence_score) failed.push(`Evidence score is below ${settings.min_auto_publish_evidence_score}`);
    } else if (!editorApproved) failed.push('Assessment scores are missing');
    if (failed.length) {
      await supabase.from('publication_queue').update({ status: 'held', hold_reason: failed.join('; '), claimed_at: null, editor_approved_at: null, editor_approved_by: null }).eq('id', queueId);
      return { action: 'held', storyId: story.id, headline: story.headline, reason: failed.join('; ') };
    }

    const publishedAt = story.published_at ?? new Date().toISOString();
    const { data: published, error: publishError } = await supabase.from('stories').update({ status: 'published', published_at: publishedAt, reviewer_id: null }).eq('id', story.id).eq('status', 'draft').select('id').maybeSingle();
    if (publishError || !published) throw publishError ?? new Error('The draft changed before it could be published.');
    await invalidatePublicPages();
    const { error: queueUpdateError } = await supabase.from('publication_queue').update({ status: 'published', published_at: publishedAt, claimed_at: null, hold_reason: null, last_error: null }).eq('id', queueId);
    await supabase.from('editorial_actions').insert({ story_id: story.id, user_id: null, action: 'published', notes: 'Article passed the automatic publication checklist and was published from the scheduled queue.' });
    try {
      await runTaxonomyGovernance({ includeTopics: true, maxEntities: 8 });
      await invalidatePublicPages();
    } catch (error) {
      console.warn('Article published, but taxonomy governance could not be refreshed', error);
    }
    return { action: queueUpdateError ? 'published_with_queue_warning' : 'published', storyId: story.id, headline: story.headline, publishedAt, warning: queueUpdateError?.message };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown automatic publication error.';
    const attempts = Number(queueItem.attempt_count ?? 1);
    if (attempts >= 3) {
      await supabase.from('publication_queue').update({ status: 'held', hold_reason: 'Automatic publishing failed three times.', last_error: detail.slice(0, 1000), claimed_at: null }).eq('id', queueId);
    } else {
      await supabase.from('publication_queue').update({ status: 'scheduled', scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString(), last_error: detail.slice(0, 1000), claimed_at: null }).eq('id', queueId);
    }
    return { action: attempts >= 3 ? 'held' : 'retry_scheduled', storyId: queueItem.story_id, reason: detail };
  }
}
