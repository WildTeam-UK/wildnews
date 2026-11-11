import { collectEnabledSources } from '@/lib/ingestion/rss';
import { assessUnprocessedItems } from '@/lib/openai/assess-news';
import { generateStoryDraft } from '@/lib/openai/draft-story';
import { estimateWebSearchCost } from '@/lib/openai/pricing';
import { researchCandidate } from '@/lib/openai/research-story';
import { queueReadyDrafts, remainingPublicationCapacityToday } from '@/lib/publication-queue';
import { enrichSourceSuggestionDescriptions, rebuildSourceSuggestionsFromResearch, scanBestSourceSuggestions } from '@/lib/source-discovery';
import { refreshSourceIntelligence } from '@/lib/source-intelligence';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { firstRelation } from '@/lib/supabase/relations';
import { candidateRankingSettings, compareRankedCandidates, hasSufficientAutomaticSources, meetsCandidateAutomationThresholds, rankCandidate } from '@/lib/candidate-ranking';
import { EDITORIAL_STEP_LEASE_SECONDS, EditorialStepLeaseLost, maintainEditorialStepLease } from '@/lib/editorial-step-lease';
import { isSameLondonDay } from '@/lib/london-time';

const ASSESSMENT_RESERVE_USD = 0.03;
const RESEARCH_RESERVE_USD = 0.06;
const DRAFT_RESERVE_USD = 0.015;
// Allow the renewable five-minute request lease to expire before recovering an item.
const STALE_STEP_MINUTES = 6;

type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'budget_stopped';
type RunStage = 'collecting' | 'assessing' | 'researching' | 'drafting' | 'finished';
type ItemStatus = 'pending' | 'researching' | 'researched' | 'drafting' | 'drafted' | 'failed';

type EditorialRun = {
  id: string;
  status: RunStatus;
  current_stage: RunStage;
  ingestion_run_id: string | null;
  max_new_drafts: number;
  max_estimated_cost_usd: number | string;
  estimated_cost_usd: number | string;
  candidates_selected: number;
  candidates_processed: number;
  drafts_created: number;
  failures: number;
  started_at: string;
  completed_at: string | null;
};

type RunItem = {
  id: string;
  cluster_id: string;
  story_id: string | null;
  rank: number;
  status: ItemStatus;
  research_cost_usd: number | string;
  draft_cost_usd: number | string;
  web_search_actions: number;
  error_message: string | null;
  updated_at: string;
  story_clusters: { working_title: string } | { working_title: string }[] | null;
};

type RunEvent = {
  id: number;
  stage: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  details: Record<string, unknown>;
  estimated_cost_usd: number | string;
  created_at: string;
};

export type EditorialRunSnapshot = {
  run: EditorialRun;
  items: RunItem[];
  events: RunEvent[];
  progressPercent: number;
  message: string;
};

const money = (value: number | string | null | undefined) => Number(value ?? 0);

function itemTitle(item: RunItem) {
  return firstRelation(item.story_clusters)?.working_title ?? 'Story candidate';
}

type RankedCandidate = {
  id: string;
  overall_score: number | null;
  evidence_score: number | null;
  relevance_score: number | null;
  assessment: { primary_topic?: string } | null;
  created_at: string;
  last_source_at: string | null;
};

async function selectRecentUndraftedCandidates(limit: number, excludedClusterIds: string[] = []) {
  const supabase = getSupabaseAdminClient();
  const settingsRequest = supabase.from('editorial_run_settings').select('candidate_freshness_days, candidate_freshness_decay_per_day, candidate_wildlife_bonus, min_auto_publish_overall_score, min_auto_publish_evidence_score').eq('id', true).single();
  const candidates: RankedCandidate[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('story_clusters').select('id, overall_score, evidence_score, relevance_score, assessment, created_at, last_source_at').eq('status', 'selected').range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as RankedCandidate[];
    candidates.push(...page);
    if (page.length < pageSize) break;
  }
  const { data: settingsRow, error: settingsError } = await settingsRequest;
  if (settingsError) throw settingsError;
  const settings = candidateRankingSettings(settingsRow);
  const minimumOverall = Number(settingsRow.min_auto_publish_overall_score ?? 55);
  const minimumEvidence = Number(settingsRow.min_auto_publish_evidence_score ?? 40);
  if (!candidates.length) return { candidates: [], settings, minimumOverall, minimumEvidence };
  const excluded = new Set(excludedClusterIds);
  const ranked = candidates
    .map((candidate) => ({ ...candidate, ranking: rankCandidate(candidate, settings) }))
    .filter((candidate) => candidate.ranking.isFresh
      && !excluded.has(candidate.id)
      && meetsCandidateAutomationThresholds(candidate, minimumOverall, minimumEvidence))
    .sort(compareRankedCandidates);
  const shortlist: typeof ranked = [];
  const safeLimit = Math.max(1, Math.min(25, limit));
  for (let from = 0; from < ranked.length && shortlist.length < safeLimit; from += 100) {
    const page = ranked.slice(from, from + 100);
    const pageIds = page.map((candidate) => candidate.id);
    const [{ data: existingStories, error: storyError }, { data: completedResearch, error: researchError }] = await Promise.all([
      supabase.from('stories').select('cluster_id').in('cluster_id', pageIds),
      supabase.from('research_packs').select('cluster_id, content').in('cluster_id', pageIds).eq('status', 'completed'),
    ]);
    if (storyError) throw storyError;
    if (researchError) throw researchError;
    const draftedIds = new Set((existingStories ?? []).flatMap((story) => story.cluster_id ? [story.cluster_id] : []));
    const sourceLimitedIds = new Set((completedResearch ?? []).flatMap((pack) => {
      const sources = (pack.content as { sources?: unknown[] } | null)?.sources;
      return Array.isArray(sources) && !hasSufficientAutomaticSources(sources.length) ? [pack.cluster_id] : [];
    }));
    shortlist.push(...page.filter((candidate) => !draftedIds.has(candidate.id) && !sourceLimitedIds.has(candidate.id)).slice(0, safeLimit - shortlist.length));
  }

  return {
    candidates: shortlist,
    settings,
    minimumOverall,
    minimumEvidence,
  };
}

async function addEvent(runId: string, stage: string, message: string, options: {
  level?: RunEvent['level'];
  details?: Record<string, unknown>;
  estimatedCostUsd?: number;
} = {}) {
  const { error } = await getSupabaseAdminClient().from('editorial_run_events').insert({
    run_id: runId,
    stage,
    level: options.level ?? 'info',
    message,
    details: options.details ?? {},
    estimated_cost_usd: options.estimatedCostUsd ?? 0,
  });
  if (error) throw error;
}

export async function getEditorialRunSnapshot(runId: string, message = ''): Promise<EditorialRunSnapshot> {
  const supabase = getSupabaseAdminClient();
  const [{ data: run, error: runError }, { data: items, error: itemsError }, { data: events, error: eventsError }] = await Promise.all([
    supabase.from('editorial_runs').select('*').eq('id', runId).single(),
    supabase.from('editorial_run_items').select('id, cluster_id, story_id, rank, status, research_cost_usd, draft_cost_usd, web_search_actions, error_message, updated_at, story_clusters(working_title)').eq('run_id', runId).order('rank'),
    supabase.from('editorial_run_events').select('id, stage, level, message, details, estimated_cost_usd, created_at').eq('run_id', runId).order('created_at', { ascending: false }).limit(30),
  ]);
  if (runError || !run) throw runError ?? new Error('Editorial run not found.');
  if (itemsError) throw itemsError;
  if (eventsError) throw eventsError;

  const typedRun = run as EditorialRun;
  const typedItems = (items ?? []) as RunItem[];
  const finishedItems = typedItems.filter((item) => ['drafted', 'failed'].includes(item.status)).length;
  const baseProgress = typedRun.current_stage === 'collecting' ? 2 : typedRun.current_stage === 'assessing' ? 8 : 12;
  const itemProgress = typedItems.length ? (finishedItems / typedItems.length) * 88 : typedRun.status === 'running' ? 0 : 88;
  const progressPercent = typedRun.status === 'running' ? Math.min(99, Math.round(baseProgress + itemProgress)) : 100;

  return { run: typedRun, items: typedItems, events: (events ?? []) as RunEvent[], progressPercent, message };
}

export async function startEditorialRun(userId: string | null, dailyArticleTarget: number, maxEstimatedCostUsd: number) {
  const supabase = getSupabaseAdminClient();
  const safeDrafts = Math.max(1, Math.min(25, Math.round(dailyArticleTarget)));
  const safeBudget = Math.max(0.05, Math.min(100, Math.round(maxEstimatedCostUsd * 100) / 100));

  const { data: active } = await supabase.from('editorial_runs').select('id').eq('status', 'running').maybeSingle();
  if (active) return getEditorialRunSnapshot(active.id, 'Resumed the run already in progress.');

  const { error: settingsError } = await supabase.from('editorial_run_settings').upsert({
    id: true,
    max_new_drafts: safeDrafts,
    max_estimated_cost_usd: safeBudget,
    updated_by: userId,
  });
  if (settingsError) throw settingsError;

  const { data: budgetStopped } = await supabase
    .from('editorial_runs')
    .select('id, estimated_cost_usd, started_at')
    .eq('status', 'budget_stopped')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (budgetStopped && isSameLondonDay(new Date(budgetStopped.started_at), new Date()) && safeBudget > money(budgetStopped.estimated_cost_usd)) {
    const { data: unfinished } = await supabase
      .from('editorial_run_items')
      .select('status')
      .eq('run_id', budgetStopped.id)
      .in('status', ['pending', 'researched'])
      .limit(1);
    if (unfinished?.length) {
      const nextStage = unfinished[0].status === 'researched' ? 'drafting' : 'researching';
      const { error: resumeError } = await supabase.from('editorial_runs').update({
        status: 'running',
        current_stage: nextStage,
        max_new_drafts: safeDrafts,
        max_estimated_cost_usd: safeBudget,
        completed_at: null,
        error_summary: null,
        publication_queue_completed_at: null,
      }).eq('id', budgetStopped.id);
      if (resumeError) throw resumeError;
      await addEvent(budgetStopped.id, 'run', `Budget-stopped run resumed with a new $${safeBudget.toFixed(2)} estimated limit.`, {
        details: { max_estimated_cost_usd: safeBudget },
      });
      return getEditorialRunSnapshot(budgetStopped.id, 'Resumed the budget-stopped run.');
    }
  }

  const { data: run, error } = await supabase.from('editorial_runs').insert({
    trigger_type: 'manual',
    status: 'running',
    current_stage: 'collecting',
    max_new_drafts: safeDrafts,
    max_estimated_cost_usd: safeBudget,
    triggered_by: userId,
  }).select('id').single();
  if (error || !run) throw error ?? new Error('Could not create the editorial run.');
  await addEvent(run.id, 'run', `Run started with a daily target of ${safeDrafts} articles and a $${safeBudget.toFixed(2)} estimated budget.`, {
    details: { daily_article_target: safeDrafts, max_estimated_cost_usd: safeBudget },
  });
  return getEditorialRunSnapshot(run.id, 'Run started.');
}

async function stopForBudget(run: EditorialRun, nextStage: string, reserve: number) {
  const spent = money(run.estimated_cost_usd);
  const budget = money(run.max_estimated_cost_usd);
  if (spent + reserve <= budget) return false;

  const supabase = getSupabaseAdminClient();
  await supabase.from('editorial_runs').update({
    status: 'budget_stopped',
    current_stage: 'finished',
    completed_at: new Date().toISOString(),
    error_summary: `Stopped before ${nextStage}: the next step was projected to exceed the run budget.`,
  }).eq('id', run.id);
  await addEvent(run.id, nextStage, `Budget safeguard stopped the run before ${nextStage}.`, {
    level: 'warning',
    details: { spent, budget, reserved_for_next_step: reserve },
  });
  await finalizeEditorialRunPublication(run.id);
  return true;
}

async function finishRun(run: EditorialRun, expired = false) {
  const status: RunStatus = expired || run.failures > 0 ? 'partial' : 'completed';
  await getSupabaseAdminClient().from('editorial_runs').update({
    status,
    current_stage: 'finished',
    completed_at: new Date().toISOString(),
  }).eq('id', run.id);
  await addEvent(run.id, 'run', expired ? 'The previous London day ended. Unpublished drafts remain private; fresh selection starts in the next daily run.' : status === 'completed' ? 'Daily editorial run completed.' : 'Run completed with one or more failed stories.', { level: status === 'partial' ? 'warning' : 'info' });
  await finalizeEditorialRunPublication(run.id);
  await refreshSourceRecommendations(run.id);
}

export async function finalizeEditorialRunPublication(runId: string) {
  const supabase = getSupabaseAdminClient();
  const { data: run, error } = await supabase.from('editorial_runs').select('status, publication_queue_completed_at').eq('id', runId).single();
  if (error) throw error;
  if (run.status === 'running' || run.publication_queue_completed_at) return;
  try {
    const queued = await queueReadyDrafts(runId, null, false);
    if (queued.queued || queued.held) {
      await addEvent(runId, 'publishing', `${queued.queued} drafts entered the automatic publishing queue; ${queued.held} were held for review.`, {
        level: queued.held ? 'warning' : 'info',
        details: queued,
      });
    }
    const { error: completedError } = await supabase.from('editorial_runs').update({ publication_queue_completed_at: new Date().toISOString() }).eq('id', runId);
    if (completedError) throw completedError;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown publication queue error.';
    await addEvent(runId, 'publishing', 'Drafting stopped, but the automatic publishing queue could not be updated. The heartbeat will retry.', {
      level: 'error',
      details: { error: detail },
    });
  }
}

export async function recoverEditorialRunPublication() {
  const { data, error } = await getSupabaseAdminClient().from('editorial_runs')
    .select('id').in('status', ['completed', 'partial', 'budget_stopped'])
    .is('publication_queue_completed_at', null).order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  if (data?.[0]) await finalizeEditorialRunPublication(data[0].id);
}

async function refreshSourceRecommendations(runId: string) {
  try {
    const rebuilt = await rebuildSourceSuggestionsFromResearch();
    const enriched = await enrichSourceSuggestionDescriptions();
    const scanned = await scanBestSourceSuggestions(8);
    const intelligence = await refreshSourceIntelligence();
    await addEvent(runId, 'sources', `Source recommendations updated automatically; ${scanned.found} usable RSS ${scanned.found === 1 ? 'feed was' : 'feeds were'} found and ${intelligence.openRecommendations} source-network ${intelligence.openRecommendations === 1 ? 'signal is' : 'signals are'} open.`, {
      details: { suggestions: rebuilt.suggestions, descriptions_created: enriched.described, feeds_checked: scanned.checked, feeds_found: scanned.found, source_network_signals: intelligence.openRecommendations },
    });
  } catch (error) {
    await addEvent(runId, 'sources', 'The editorial run completed, but source recommendations could not be refreshed.', {
      level: 'warning',
      details: { error: error instanceof Error ? error.message : 'Unknown source recommendation error.' },
    });
  }
}

async function recoverStaleItems(runId: string) {
  const supabase = getSupabaseAdminClient();
  const staleBefore = new Date(Date.now() - STALE_STEP_MINUTES * 60_000).toISOString();
  const { data: stale } = await supabase.from('editorial_run_items').select('id, status').eq('run_id', runId).in('status', ['researching', 'drafting']).lt('updated_at', staleBefore);
  for (const item of stale ?? []) {
    const nextStatus = item.status === 'researching' ? 'pending' : 'researched';
    await supabase.from('editorial_run_items').update({ status: nextStatus, error_message: 'Recovered after an interrupted request.' }).eq('id', item.id);
    await addEvent(runId, item.status, 'Recovered an interrupted step and made it ready to retry.', { level: 'warning', details: { item_id: item.id } });
  }
}

export async function advanceEditorialRun(runId: string, userId: string | null): Promise<EditorialRunSnapshot> {
  const supabase = getSupabaseAdminClient();
  const { data: leaseToken, error: leaseError } = await supabase.rpc('claim_editorial_run_step', { target_run_id: runId, lease_seconds: EDITORIAL_STEP_LEASE_SECONDS });
  if (leaseError) throw leaseError;
  if (!leaseToken) return getEditorialRunSnapshot(runId, 'Another request is already advancing this run.');
  const lease = maintainEditorialStepLease(async () => {
    const { data, error } = await supabase.rpc('renew_editorial_run_step', { target_run_id: runId, target_lease_token: leaseToken, lease_seconds: EDITORIAL_STEP_LEASE_SECONDS });
    if (error) throw error;
    return data === true;
  });

  try {
  await recoverStaleItems(runId);
  const { data: runData, error: runError } = await supabase.from('editorial_runs').select('*').eq('id', runId).single();
  if (runError || !runData) throw runError ?? new Error('Editorial run not found.');
  let run = runData as EditorialRun;
  if (run.status !== 'running') return getEditorialRunSnapshot(run.id, 'This run is no longer active.');
  await lease.assertActive();
  if (!isSameLondonDay(new Date(run.started_at), new Date())) {
    await finishRun(run, true);
    return getEditorialRunSnapshot(run.id, 'The previous day ended; its private drafts will not displace fresh selection.');
  }

  if (run.current_stage === 'collecting') {
    const result = await collectEnabledSources('manual', run.ingestion_run_id);
    await lease.assertActive();
    const collectionFinished = ['completed', 'partial', 'failed'].includes(result.status);
    await supabase.from('editorial_runs').update({
      ingestion_run_id: result.runId,
      current_stage: collectionFinished ? 'assessing' : 'collecting',
    }).eq('id', run.id);
    await addEvent(run.id, 'collecting', collectionFinished
      ? `Collection finished after checking ${result.sourcesChecked} sources and finding ${result.itemsNew} new items.`
      : `Checked ${result.sourcesChecked} sources and found ${result.itemsNew} new items; ${result.remainingSources} source checks remain.`, {
      level: result.status === 'completed' || result.status === 'collecting' ? 'info' : 'warning',
      details: result,
    });
    return getEditorialRunSnapshot(run.id, collectionFinished
      ? 'Collection complete. Assessing the new inbox next.'
      : `Collection safely paused with ${result.remainingSources} source checks remaining.`);
  }

  if (run.current_stage === 'assessing') {
    if (await stopForBudget(run, 'assessment', ASSESSMENT_RESERVE_USD)) return getEditorialRunSnapshot(run.id, 'Stopped at the budget safeguard.');
    const result = await assessUnprocessedItems();
    await lease.assertActive();
    const nextCost = money(run.estimated_cost_usd) + result.estimatedCostUsd;
    if (result.remainingItems > 0) {
      await supabase.from('editorial_runs').update({ estimated_cost_usd: nextCost }).eq('id', run.id);
      await addEvent(run.id, 'assessing', `Assessed a batch of ${result.assessedItems} items; ${result.remainingItems} recent items remain.`, {
        details: { assessed_items: result.assessedItems, new_candidates: result.selected, matched_items: result.matchedItems, updates_flagged: result.updatesFlagged, expired_items: result.expiredItems, remaining_items: result.remainingItems },
        estimatedCostUsd: result.estimatedCostUsd,
      });
      return getEditorialRunSnapshot(run.id, `Assessed ${result.assessedItems} items. ${result.remainingItems} remain in the recent backlog.`);
    }

    const remainingCapacity = await remainingPublicationCapacityToday(run.max_new_drafts, run.id);
    const shortlistResult = remainingCapacity > 0
      ? await selectRecentUndraftedCandidates(remainingCapacity)
      : { candidates: [], settings: candidateRankingSettings(null), minimumOverall: 55, minimumEvidence: 40 };
    const shortlist = shortlistResult.candidates;
    await lease.assertActive();
    const { error: selectionError } = await supabase.rpc('select_editorial_run_candidates', {
      target_run_id: run.id, target_lease_token: leaseToken, candidate_ids: shortlist.map((candidate) => candidate.id), initial_selection: true,
    });
    if (selectionError) throw selectionError;
    const completed = shortlist.length === 0;
    await supabase.from('editorial_runs').update({
      current_stage: completed ? 'finished' : 'researching',
      status: completed ? 'completed' : 'running',
      completed_at: completed ? new Date().toISOString() : null,
      candidates_selected: shortlist.length,
      estimated_cost_usd: nextCost,
    }).eq('id', run.id);
    await addEvent(run.id, 'assessing', remainingCapacity > 0
      ? `Assessed ${result.assessedItems} new items, then selected the top ${shortlist.length} recent undrafted candidates for today's remaining capacity.`
      : `Assessed ${result.assessedItems} new items; today's article target was already filled.`, {
      details: { assessed_items: result.assessedItems, new_candidates: result.selected, rejected: result.rejected, matched_items: result.matchedItems, updates_flagged: result.updatesFlagged, expired_items: result.expiredItems, daily_article_target: run.max_new_drafts, remaining_publication_capacity: remainingCapacity, recent_pool_shortlist: shortlist.length, minimum_overall_score: shortlistResult.minimumOverall, minimum_evidence_score: shortlistResult.minimumEvidence, freshness_days: shortlistResult.settings.freshnessDays, freshness_decay_per_day: shortlistResult.settings.freshnessDecayPerDay, wildlife_bonus: shortlistResult.settings.wildlifeBonus, selected_effective_scores: shortlist.map((candidate) => ({ cluster_id: candidate.id, effective_score: candidate.ranking.effectiveScore })) },
      estimatedCostUsd: result.estimatedCostUsd,
    });
    if (completed) {
      await addEvent(run.id, 'run', remainingCapacity > 0 ? 'Run completed because there were no new qualifying candidates.' : "Run completed because today's article target was already filled.");
      await refreshSourceRecommendations(run.id);
      await finalizeEditorialRunPublication(run.id);
    }
    return getEditorialRunSnapshot(run.id, completed ? remainingCapacity > 0 ? 'No new qualifying candidates were found.' : "Today's article target is already filled." : 'Assessment complete. Researching the first candidate next.');
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from('editorial_run_items')
    .select('id, cluster_id, story_id, rank, status, research_cost_usd, draft_cost_usd, web_search_actions, error_message, updated_at, story_clusters(working_title)')
    .eq('run_id', run.id)
    .order('rank');
  if (itemsError) throw itemsError;
  const items = (itemRows ?? []) as RunItem[];
  await lease.assertActive();
  const draftedCount = items.filter((item) => item.status === 'drafted').length;
  const remainingCapacity = await remainingPublicationCapacityToday(run.max_new_drafts, run.id);
  if (draftedCount >= Math.min(run.max_new_drafts, remainingCapacity)) {
    await finishRun({ ...run, failures: items.filter((item) => item.status === 'failed').length });
    return getEditorialRunSnapshot(run.id, 'The daily article target is filled. No additional research or drafts will be created.');
  }

  const readyToDraft = items.find((item) => item.status === 'researched');
  if (readyToDraft) {
    if (await stopForBudget(run, 'drafting', DRAFT_RESERVE_USD)) return getEditorialRunSnapshot(run.id, 'Stopped at the budget safeguard.');
    await supabase.from('editorial_run_items').update({ status: 'drafting', error_message: null }).eq('id', readyToDraft.id);
    await supabase.from('editorial_runs').update({ current_stage: 'drafting' }).eq('id', run.id);
    try {
      const result = await generateStoryDraft(readyToDraft.cluster_id, userId, { beforeSave: async () => {
        await lease.assertActive();
        if (!isSameLondonDay(new Date(run.started_at), new Date())) throw new EditorialStepLeaseLost();
      } });
      await lease.assertActive();
      const cost = result.alreadyCompleted ? 0 : result.estimatedCostUsd;
      const nextCost = money(run.estimated_cost_usd) + cost;
      await supabase.from('editorial_run_items').update({ status: 'drafted', story_id: result.storyId, draft_cost_usd: cost }).eq('id', readyToDraft.id);
      await supabase.from('editorial_runs').update({
        current_stage: 'researching',
        estimated_cost_usd: nextCost,
        candidates_processed: run.candidates_processed + 1,
        drafts_created: run.drafts_created + (result.alreadyCompleted ? 0 : 1),
      }).eq('id', run.id);
      await addEvent(run.id, 'drafting', `Draft created: ${result.headline}`, { details: { cluster_id: readyToDraft.cluster_id, story_id: result.storyId }, estimatedCostUsd: cost });
      return getEditorialRunSnapshot(run.id, `Draft ${run.drafts_created + 1} of ${run.candidates_selected} created.`);
    } catch (error) {
      if (error instanceof EditorialStepLeaseLost) throw error;
      await lease.assertActive();
      const detail = error instanceof Error ? error.message : 'Unknown drafting error.';
      await supabase.from('editorial_run_items').update({ status: 'failed', error_message: detail.slice(0, 1000) }).eq('id', readyToDraft.id);
      await supabase.from('editorial_runs').update({ current_stage: 'researching', candidates_processed: run.candidates_processed + 1, failures: run.failures + 1 }).eq('id', run.id);
      await addEvent(run.id, 'drafting', `Drafting failed for ${itemTitle(readyToDraft)}.`, { level: 'error', details: { error: detail, cluster_id: readyToDraft.cluster_id } });
      return getEditorialRunSnapshot(run.id, 'One draft failed; the remaining candidates can continue.');
    }
  }

  const readyToResearch = items.find((item) => item.status === 'pending');
  if (readyToResearch) {
    const completedResearch = items.filter((item) => money(item.research_cost_usd) > 0);
    const observedAverage = completedResearch.length ? completedResearch.reduce((sum, item) => sum + money(item.research_cost_usd), 0) / completedResearch.length : 0;
    const reserve = Math.max(RESEARCH_RESERVE_USD, observedAverage * 1.25);
    if (await stopForBudget(run, 'researching', reserve)) return getEditorialRunSnapshot(run.id, 'Stopped at the budget safeguard.');
    await supabase.from('editorial_run_items').update({ status: 'researching', error_message: null }).eq('id', readyToResearch.id);
    await supabase.from('editorial_runs').update({ current_stage: 'researching' }).eq('id', run.id);
    try {
      const result = await researchCandidate(readyToResearch.cluster_id);
      await lease.assertActive();
      const cost = result.alreadyCompleted ? 0 : result.estimatedTokenCostUsd + estimateWebSearchCost(result.searchActions);
      const nextCost = money(run.estimated_cost_usd) + cost;
      if (!hasSufficientAutomaticSources(result.sourceCount)) {
        const reason = `Research found ${result.sourceCount} usable ${result.sourceCount === 1 ? 'source' : 'sources'}; automatic publishing requires at least 3.`;
        await supabase.from('editorial_run_items').update({ status: 'failed', research_cost_usd: cost, web_search_actions: result.searchActions, error_message: reason }).eq('id', readyToResearch.id);
        await supabase.from('editorial_runs').update({ current_stage: 'researching', estimated_cost_usd: nextCost, candidates_processed: run.candidates_processed + 1, failures: run.failures + 1 }).eq('id', run.id);
        await addEvent(run.id, 'researching', `Research stopped before drafting ${itemTitle(readyToResearch)} because it did not meet the automatic source threshold.`, {
          level: 'warning',
          details: { cluster_id: readyToResearch.cluster_id, sources: result.sourceCount, minimum_sources: 3, web_search_actions: result.searchActions },
          estimatedCostUsd: cost,
        });
        return getEditorialRunSnapshot(run.id, 'A candidate did not have enough usable sources. The next eligible candidate will be selected.');
      }
      await supabase.from('editorial_run_items').update({ status: 'researched', research_cost_usd: cost, web_search_actions: result.searchActions }).eq('id', readyToResearch.id);
      await supabase.from('editorial_runs').update({ current_stage: 'drafting', estimated_cost_usd: nextCost }).eq('id', run.id);
      await addEvent(run.id, 'researching', `Research completed for ${itemTitle(readyToResearch)}.`, {
        details: { cluster_id: readyToResearch.cluster_id, sources: result.sourceCount, web_search_actions: result.searchActions },
        estimatedCostUsd: cost,
      });
      return getEditorialRunSnapshot(run.id, 'Research complete. Creating its private draft next.');
    } catch (error) {
      if (error instanceof EditorialStepLeaseLost) throw error;
      await lease.assertActive();
      const detail = error instanceof Error ? error.message : 'Unknown research error.';
      await supabase.from('editorial_run_items').update({ status: 'failed', error_message: detail.slice(0, 1000) }).eq('id', readyToResearch.id);
      await supabase.from('editorial_runs').update({ candidates_processed: run.candidates_processed + 1, failures: run.failures + 1 }).eq('id', run.id);
      await addEvent(run.id, 'researching', `Research failed for ${itemTitle(readyToResearch)}.`, { level: 'error', details: { error: detail, cluster_id: readyToResearch.cluster_id } });
      return getEditorialRunSnapshot(run.id, 'One research step failed; the remaining candidates can continue.');
    }
  }

  if (items.some((item) => ['researching', 'drafting'].includes(item.status))) {
    return getEditorialRunSnapshot(run.id, 'Waiting for an in-progress step to finish or become ready for recovery.');
  }

  const replacementsNeeded = Math.max(0, remainingCapacity - draftedCount);
  if (replacementsNeeded > 0) {
    const replacementResult = await selectRecentUndraftedCandidates(replacementsNeeded, items.map((item) => item.cluster_id));
    if (replacementResult.candidates.length) {
      await lease.assertActive();
      const { data: selectedCount, error: replacementError } = await supabase.rpc('select_editorial_run_candidates', {
        target_run_id: run.id, target_lease_token: leaseToken, candidate_ids: replacementResult.candidates.map((candidate) => candidate.id), initial_selection: false,
      });
      if (replacementError) throw replacementError;
      await supabase.from('editorial_runs').update({
        current_stage: 'researching',
        candidates_selected: items.length + Number(selectedCount ?? 0),
      }).eq('id', run.id);
      await addEvent(run.id, 'researching', `${replacementResult.candidates.length} replacement ${replacementResult.candidates.length === 1 ? 'candidate was' : 'candidates were'} selected after earlier work could not produce today’s full article target.`, {
        details: {
          replacement_candidates: replacementResult.candidates.map((candidate) => candidate.id),
          minimum_overall_score: replacementResult.minimumOverall,
          minimum_evidence_score: replacementResult.minimumEvidence,
        },
      });
      return getEditorialRunSnapshot(run.id, 'The next eligible candidate has been added to replace unsuccessful work.');
    }
  }

  run = { ...run, failures: items.filter((item) => item.status === 'failed').length };
  await finishRun(run);
  return getEditorialRunSnapshot(run.id, run.failures ? 'Run completed with some failed candidates.' : 'Run completed successfully.');
  } finally {
    await lease.stop();
    await supabase.rpc('release_editorial_run_step', { target_run_id: runId, target_lease_token: leaseToken });
  }
}
