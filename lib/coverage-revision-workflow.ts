import type { SupabaseClient } from '@supabase/supabase-js';
import { articleLinkRows } from '@/lib/article-linking';
import { recordUnsplashSelection } from '@/lib/images/unsplash';
import type { StoryDraftContent } from '@/lib/openai/draft-story';
import { generateEditorialRevision, revisionChangesPublicContent } from '@/lib/openai/generate-editorial-revision';
import { generateRevisionSummary, type RevisionSummaryEvidence } from '@/lib/openai/generate-revision-summary';
import { publicRevisionSourceIds } from '@/lib/revision-source-references';
import { firstRelation, sourceRelationName } from '@/lib/supabase/relations';
import { invalidatePublicPages } from '@/lib/invalidate-public-pages';

type StoredSource = {
  id: string;
  title: string;
  publisher: string;
  url: string;
  source_type: string;
  source_item_id?: string;
  published_at?: string | null;
};

type ClaimedWork = {
  work_type: 'apply_revision' | 'prepare_updates';
  revision_id: string | null;
  update_id: string | null;
};

function sourceOnlyChangeSummary(evidence: RevisionSummaryEvidence[]) {
  const publishers = [...new Set(evidence.map((item) => item.publisher.trim()).filter(Boolean))];
  if (!publishers.length) return 'The source list was updated with additional reporting. The briefing text was unchanged.';
  const publisherList = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(publishers);
  return `The source list was updated with additional reporting from ${publisherList}. The briefing text was unchanged.`;
}

async function loadDraftRevision(supabase: SupabaseClient, id: string) {
  return supabase.from('story_editorial_revisions').select('id, story_id, status, base_content, proposed_content, source_list, public_content_changed').eq('id', id).maybeSingle();
}

export async function prepareCoverageUpdate(input: {
  supabase: SupabaseClient;
  updateId: string;
  actorId: string | null;
  claimedAutomatically?: boolean;
}) {
  const { supabase, updateId, actorId, claimedAutomatically = false } = input;
  const { data: update, error: updateError } = await supabase
    .from('story_cluster_updates')
    .select('id, cluster_id, source_item_id, status, relationship, rationale, source_items(id, title, url, published_at, summary, raw_content, sources(name))')
    .eq('id', updateId)
    .maybeSingle();
  if (updateError) throw updateError;
  if (!update) throw new Error('Coverage update not found.');
  const expectedStatus = claimedAutomatically ? 'processing' : 'pending_review';
  if (update.status !== expectedStatus) throw new Error('This coverage update has already been reviewed.');

  const { data: story, error: storyError } = await supabase
    .from('stories')
    .select('id, generation_metadata')
    .eq('cluster_id', update.cluster_id)
    .eq('content_type', 'news')
    .in('status', ['draft', 'published'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (storyError) throw storyError;
  if (!story) throw new Error('The linked article could not be found.');

  const metadata = story.generation_metadata as { article_content?: StoryDraftContent; source_ids?: StoredSource[] };
  if (!metadata.article_content) throw new Error('The linked article has no editable content.');
  const sourceItem = firstRelation(update.source_items);
  if (!sourceItem) throw new Error('The matched source could not be loaded.');

  const { data: existingRevision, error: revisionLookupError } = await supabase
    .from('story_editorial_revisions')
    .select('id, base_content, proposed_content, source_list, created_by')
    .eq('story_id', story.id)
    .eq('status', 'draft')
    .maybeSingle();
  if (revisionLookupError) throw revisionLookupError;
  if (claimedAutomatically && existingRevision?.created_by) {
    throw new Error('This article already has a revision awaiting editorial review.');
  }

  const currentSources = ((existingRevision?.source_list ?? metadata.source_ids ?? []) as StoredSource[]);
  const nextSourceNumber = currentSources.reduce((maximum, source) => {
    const number = Number(source.id.replace('source-', ''));
    return Number.isFinite(number) ? Math.max(maximum, number) : maximum;
  }, 0) + 1;
  const appendedSource: StoredSource = {
    id: `source-${nextSourceNumber}`,
    source_item_id: update.source_item_id,
    title: sourceItem.title,
    publisher: sourceRelationName(sourceItem.sources, 'Source'),
    url: sourceItem.url,
    source_type: currentSources.length ? 'supporting' : 'primary',
    published_at: sourceItem.published_at,
  };
  const revisionSource = currentSources.find((source) => source.url === appendedSource.url) ?? appendedSource;
  const sourceList = revisionSource === appendedSource ? [...currentSources, appendedSource] : currentSources;
  const revisionGeneration = await generateEditorialRevision({
    currentContent: (existingRevision?.proposed_content ?? metadata.article_content) as StoryDraftContent,
    sources: sourceList,
    update: {
      sourceId: revisionSource.id,
      title: sourceItem.title,
      publisher: appendedSource.publisher,
      publishedAt: sourceItem.published_at,
      relationship: update.relationship,
      rationale: update.rationale,
      summary: sourceItem.summary,
      rawContent: sourceItem.raw_content,
    },
  });
  const baseContent = (existingRevision?.base_content ?? metadata.article_content) as StoryDraftContent;
  const contentChanged = revisionChangesPublicContent(baseContent, revisionGeneration.content);
  const { error: generationError } = await supabase.from('ai_generations').insert({
    story_id: story.id,
    cluster_id: update.cluster_id,
    purpose: 'revision_draft',
    provider: 'openai',
    model: revisionGeneration.model,
    prompt_version: revisionGeneration.promptVersion,
    input_tokens: revisionGeneration.inputTokens,
    output_tokens: revisionGeneration.outputTokens,
    estimated_cost_usd: revisionGeneration.estimatedCostUsd,
    warnings: [],
  });
  if (generationError) throw generationError;

  let revisionId = existingRevision?.id;
  if (revisionId) {
    const { error } = await supabase.from('story_editorial_revisions').update({
      proposed_content: revisionGeneration.content,
      source_list: sourceList,
      public_content_changed: contentChanged,
      ...(claimedAutomatically ? { automation_claimed_at: new Date().toISOString() } : {}),
    }).eq('id', revisionId).eq('status', 'draft');
    if (error) throw error;
  } else {
    const { data: revision, error } = await supabase.from('story_editorial_revisions').insert({
      story_id: story.id,
      base_content: metadata.article_content,
      proposed_content: revisionGeneration.content,
      source_list: sourceList,
      public_content_changed: contentChanged,
      created_by: actorId,
      automation_attempt_count: claimedAutomatically ? 1 : 0,
      automation_claimed_at: claimedAutomatically ? new Date().toISOString() : null,
    }).select('id').single();
    if (error) throw error;
    revisionId = revision.id;
  }

  const { error: linkError } = await supabase.from('story_editorial_revision_updates').upsert({ revision_id: revisionId, update_id: update.id }, { onConflict: 'update_id' });
  if (linkError) throw linkError;
  const { data: claimedUpdate, error: statusError } = await supabase.from('story_cluster_updates')
    .update({ status: 'in_revision', automation_claimed_at: null })
    .eq('id', update.id)
    .eq('status', expectedStatus)
    .select('id')
    .maybeSingle();
  if (statusError) throw statusError;
  if (!claimedUpdate) throw new Error('The coverage update lease was lost before the revision was saved.');

  return { reviewed: true, status: 'in_revision' as const, revisionId, contentChanged };
}

export async function applyEditorialRevision(supabase: SupabaseClient, revisionId: string) {
  const { data: revision, error: revisionError } = await loadDraftRevision(supabase, revisionId);
  if (revisionError) throw revisionError;
  if (!revision) throw new Error('Editorial revision not found.');
  if (revision.status !== 'draft') throw new Error('This editorial revision has already been resolved.');
  const proposedContent = revision.proposed_content as StoryDraftContent;
  const baseContent = revision.base_content as StoryDraftContent;
  const contentChanged = revisionChangesPublicContent(baseContent, proposedContent);
  const { data: revisionLinks, error: revisionLinksError } = await supabase.from('story_editorial_revision_updates').select('update_id').eq('revision_id', revisionId);
  if (revisionLinksError) throw revisionLinksError;
  const updateIds = (revisionLinks ?? []).map((link) => link.update_id);
  let coverageEvidence: RevisionSummaryEvidence[] = [];
  let coverageSourceItemIds: string[] = [];
  if (updateIds.length) {
    const { data: updates, error: updatesError } = await supabase
      .from('story_cluster_updates')
      .select('source_item_id, relationship, rationale, source_items(title, sources(name))')
      .in('id', updateIds);
    if (updatesError) throw updatesError;
    coverageSourceItemIds = (updates ?? []).map((update) => update.source_item_id);
    coverageEvidence = (updates ?? []).flatMap((update) => {
      const sourceItem = firstRelation(update.source_items);
      return sourceItem ? [{
        relationship: update.relationship,
        rationale: update.rationale,
        title: sourceItem.title,
        publisher: sourceRelationName(sourceItem.sources, 'Source'),
      }] : [];
    });
  }
  const generatedSummary = contentChanged ? await generateRevisionSummary({ baseContent, proposedContent, coverageEvidence }) : null;
  const changeSummary = generatedSummary?.summary ?? sourceOnlyChangeSummary(coverageEvidence);
  const publicSourceIds = publicRevisionSourceIds((revision.source_list ?? []) as StoredSource[], coverageSourceItemIds);
  const { error: summaryError } = await supabase.from('story_editorial_revisions').update({ change_summary: changeSummary, public_content_changed: contentChanged, public_source_ids: publicSourceIds }).eq('id', revisionId).eq('status', 'draft');
  if (summaryError) throw summaryError;
  if (generatedSummary) {
    const { error: generationLogError } = await supabase.from('ai_generations').insert({
      story_id: revision.story_id,
      purpose: 'revision_summary',
      provider: 'openai',
      model: generatedSummary.model,
      prompt_version: generatedSummary.promptVersion,
      input_tokens: generatedSummary.inputTokens,
      output_tokens: generatedSummary.outputTokens,
      estimated_cost_usd: generatedSummary.estimatedCostUsd,
      warnings: [],
    });
    if (generationLogError) throw generationLogError;
  }
  const { data: storyId, error: applyError } = await supabase.rpc('apply_story_editorial_revision_v2', { target_revision_id: revisionId, has_public_content_changes: contentChanged });
  if (applyError) throw applyError;
  await invalidatePublicPages();

  const warnings: string[] = [];
  try {
    const contextualLinks = articleLinkRows(storyId, proposedContent);
    const { error: clearLinksError } = await supabase.from('story_contextual_links').delete().eq('story_id', storyId);
    if (clearLinksError) throw clearLinksError;
    if (contextualLinks.length) {
      const { error: linkError } = await supabase.from('story_contextual_links').insert(contextualLinks);
      if (linkError) throw linkError;
    }
  } catch (error) {
    console.warn('Editorial revision applied, but contextual links could not be refreshed', error);
    warnings.push('Contextual links could not be refreshed.');
  }
  const newCredit = proposedContent.image_credit;
  const oldCredit = baseContent.image_credit;
  if (newCredit?.provider === 'unsplash' && newCredit.source_id !== oldCredit?.source_id) {
    try {
      await recordUnsplashSelection(newCredit.download_location);
    } catch (error) {
      console.warn('Unsplash selection tracking failed after applying an editorial revision', error);
      warnings.push('Unsplash selection tracking could not be recorded.');
    }
  }
  await invalidatePublicPages();
  return { applied: true as const, storyId, warnings, contentChanged };
}

export async function processAutomatedCoverageUpdates(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc('claim_coverage_update_work', { lease_seconds: 900, batch_size: 5 });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code ?? '')) return null;
    throw error;
  }
  const work = (data ?? []) as ClaimedWork[];
  if (!work.length) return null;

  const revisionWork = work.find((item) => item.work_type === 'apply_revision' && item.revision_id);
  if (revisionWork?.revision_id) {
    try {
      const applied = await applyEditorialRevision(supabase, revisionWork.revision_id);
      return { action: 'revision_applied' as const, revisionId: revisionWork.revision_id, ...applied };
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'Automatic revision application failed.';
      console.warn('Automatic editorial revision will be retried', caught);
      await supabase.rpc('release_coverage_revision_work', { target_revision_id: revisionWork.revision_id, error_detail: detail, retry_seconds: 300 });
      return { action: 'revision_retry_scheduled' as const, revisionId: revisionWork.revision_id, error: detail };
    }
  }

  const updateIds = work.flatMap((item) => item.update_id ? [item.update_id] : []);
  if (!updateIds.length) return null;
  let revisionId: string | null = null;
  let allUpdatesPrepared = false;
  try {
    for (const updateId of updateIds) {
      const prepared = await prepareCoverageUpdate({ supabase, updateId, actorId: null, claimedAutomatically: true });
      revisionId = prepared.revisionId;
    }
    allUpdatesPrepared = true;
    if (!revisionId) throw new Error('Automatic coverage processing did not create a revision.');
    const applied = await applyEditorialRevision(supabase, revisionId);
    return { action: 'updates_applied' as const, updateCount: updateIds.length, revisionId, ...applied };
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : 'Automatic coverage processing failed.';
    console.warn('Automatic coverage update will be retried', caught);
    await supabase.rpc('release_coverage_update_work', { update_ids: updateIds, error_detail: detail, retry_seconds: 300 });
    if (revisionId) await supabase.rpc('release_coverage_revision_work', { target_revision_id: revisionId, error_detail: detail, retry_seconds: allUpdatesPrepared ? 300 : 600 });
    return { action: 'update_retry_scheduled' as const, updateCount: updateIds.length, revisionId, error: detail };
  }
}
