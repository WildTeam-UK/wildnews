import { randomUUID } from 'node:crypto';
import { bufferChannelIds, createBufferPost, type BufferPostPayload } from '@/lib/distribution/buffer';
import { brevoCampaignIsSubmitted, createBrevoCampaign, sendBrevoCampaign, type BrevoCampaignPayload } from '@/lib/distribution/brevo';
import { SOCIAL_EDITORIAL_DESTINATION } from '@/lib/distribution/constants';
import { assertSocialPostingWindow, SocialPostingWindowExpired } from '@/lib/distribution/social-window';
import { buildEmailDistributionPayload, buildSocialDistributionPayload } from '@/lib/distribution/digest-content';
import { DistributionProviderError } from '@/lib/distribution/errors';
import { digestPath, type DigestContent, type DigestSourceStory, type DigestType } from '@/lib/digests';
import { generateSocialEditorial, SOCIAL_GENERATION_PROMPT_VERSION, SocialEditorialValidationError, type SocialEvidenceStory } from '@/lib/openai/generate-social-post';
import { positiveIntegerEnvironmentValue } from '@/lib/environment';
import { absoluteUrl } from '@/lib/seo';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

type DeliveryProvider = 'buffer' | 'brevo';
type DeliveryStatus = 'pending' | 'processing' | 'submitted' | 'completed' | 'failed' | 'uncertain' | 'cancelled' | 'unsent';

type DeliveryRecord = {
  id: string;
  run_id: string;
  story_id: string;
  provider: DeliveryProvider;
  destination: string;
  status: DeliveryStatus;
  payload: Record<string, unknown>;
  provider_reference: string | null;
  attempt_count: number;
  lease_token: string | null;
};

type DigestStory = {
  id: string;
  slug: string;
  status: string;
  content_type: 'daily_digest' | 'weekly_digest';
  image_url: string | null;
  image_alt: string | null;
  generation_metadata: {
    digest_content?: DigestContent;
    digest_source_stories?: DigestSourceStory[];
  };
};

type SocialSourceMetadata = {
  article_content?: {
    story_at_a_glance?: Array<{ text?: string }>;
    key_takeaways?: Array<{ text?: string }>;
    why_it_matters?: { text?: string };
    what_happens_next?: { text?: string };
  };
};

type SocialSourceRow = {
  id: string;
  headline: string;
  standfirst: string;
  overview: string | null;
  key_takeaways: Array<string | { text?: string }> | null;
  generation_metadata: SocialSourceMetadata | null;
};

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : 'The provider request failed.').replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function editionDetails(story: DigestStory) {
  const type: DigestType = story.content_type === 'weekly_digest' ? 'weekly' : 'daily';
  return { type, editionDate: story.slug.replace(`${type}-digest-`, '') };
}

function evidenceText(items: Array<{ text?: string }> | undefined) {
  return (items ?? []).map((item) => item.text?.trim()).filter((value): value is string => Boolean(value));
}

function storedTakeaways(items: Array<string | { text?: string }> | null) {
  return (items ?? []).flatMap((item) => {
    const value = typeof item === 'string' ? item : item.text;
    return value?.trim() ? [value.trim()] : [];
  });
}

function socialEvidence(sourceStories: DigestSourceStory[], rows: SocialSourceRow[]): SocialEvidenceStory[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return sourceStories.flatMap((source, index) => {
    const row = byId.get(source.id);
    if (!row) return [];
    const article = row.generation_metadata?.article_content;
    return [{
      id: row.id,
      digest_reference_id: `story-${index + 1}`,
      headline: row.headline || source.headline,
      standfirst: row.standfirst || source.standfirst,
      overview: row.overview?.trim() ?? '',
      key_takeaways: evidenceText(article?.key_takeaways).length ? evidenceText(article?.key_takeaways) : storedTakeaways(row.key_takeaways),
      story_at_a_glance: evidenceText(article?.story_at_a_glance),
      why_it_matters: article?.why_it_matters?.text?.trim() ?? '',
      what_happens_next: article?.what_happens_next?.text?.trim() ?? '',
    }];
  });
}

async function recordPreparationFailure(runId: string, storyId: string, provider: DeliveryProvider, message: string) {
  const supabase = getSupabaseAdminClient();
  await Promise.all([
    supabase.from('digest_runs').update({
      status: 'partial',
      ...(provider === 'buffer' ? { social_status: 'failed' } : { email_status: 'failed' }),
      error_summary: message.slice(0, 1000),
    }).eq('id', runId),
    supabase.from('digest_deliveries').upsert({ id: randomUUID(), run_id: runId, story_id: storyId, provider, destination: 'configuration', status: 'failed', payload: {}, last_error: message.slice(0, 1000), completed_at: new Date().toISOString() }, { onConflict: 'run_id,provider,destination', ignoreDuplicates: true }),
    supabase.from('digest_run_events').insert({ run_id: runId, stage: 'distribution', level: 'error', message: message.slice(0, 1000), details: { provider } }),
  ]);
}

async function prepareSocialEditorialDeliveries(delivery: DeliveryRecord) {
  const supabase = getSupabaseAdminClient();
  const [{ data: settings, error: settingsError }, { data: story, error: storyError }, { data: run, error: runError }] = await Promise.all([
    supabase.from('digest_settings').select('social_distribution_enabled, max_estimated_cost_usd').eq('id', true).single(),
    supabase.from('stories').select('id, slug, status, content_type, image_url, generation_metadata').eq('id', delivery.story_id).single(),
    supabase.from('digest_runs').select('id, period_end, estimated_cost_usd, social_copy').eq('id', delivery.run_id).single(),
  ]);
  if (settingsError || storyError || runError || !settings || !story || !run) throw settingsError ?? storyError ?? runError ?? new Error('Social editorial preparation could not be loaded.');
  assertSocialPostingWindow(run.period_end);
  if (!settings.social_distribution_enabled) throw new SocialEditorialValidationError('Social distribution is no longer enabled.');
  if (story.status !== 'published' || !['daily_digest', 'weekly_digest'].includes(story.content_type)) throw new SocialEditorialValidationError('Social editorial copy can only be generated from a published digest.');
  const digestStory = story as DigestStory;
  const content = digestStory.generation_metadata.digest_content;
  if (!content) throw new SocialEditorialValidationError('The published digest has no verified content for social editorial generation.');
  const { type, editionDate } = editionDetails(digestStory);
  const channels = bufferChannelIds();
  if (!channels.length || !(process.env.BUFFER_API_KEY ?? '').trim()) throw new SocialEditorialValidationError('BUFFER_API_KEY or BUFFER_CHANNEL_IDS is not configured.');
  const requestedMode = delivery.payload.mode;
  if (requestedMode !== 'shareNow' && requestedMode !== 'addToQueue') throw new SocialEditorialValidationError('The stored Buffer publishing mode is invalid.');
  const mode = requestedMode;
  const savedMode = mode === 'shareNow' ? 'immediate' : 'queue';
  const stored = run.social_copy as Record<string, unknown> | null;
  const storedText = stored?.generation_prompt_version === SOCIAL_GENERATION_PROMPT_VERSION && typeof stored.text === 'string' && stored.text.trim() ? stored.text : null;
  const publicUrl = absoluteUrl(digestPath(type, editionDate));
  let socialCopy = stored ?? {};
  let text = storedText;
  let newEstimatedCost = 0;

  if (!text) {
    const sourceSnapshots = digestStory.generation_metadata.digest_source_stories ?? [];
    const sourceIds = [...new Set(sourceSnapshots.map((source) => source.id))];
    const [{ data: sourceRows, error: sourceError }, { data: recentRuns, error: recentError }] = await Promise.all([
      supabase.from('stories').select('id, headline, standfirst, overview, key_takeaways, generation_metadata').in('id', sourceIds).eq('status', 'published'),
      supabase.from('digest_runs').select('social_copy').neq('id', delivery.run_id).order('created_at', { ascending: false }).limit(8),
    ]);
    if (sourceError || recentError) throw sourceError ?? recentError ?? new Error('Social editorial evidence could not be loaded.');
    const evidence = socialEvidence(sourceSnapshots, (sourceRows ?? []) as SocialSourceRow[]);
    if (!evidence.length) throw new SocialEditorialValidationError('No published source-story evidence was available for social editorial generation.');
    const recentPosts = (recentRuns ?? []).flatMap((recent) => {
      const copy = recent.social_copy as { text?: unknown } | null;
      return typeof copy?.text === 'string' && copy.text.trim() ? [copy.text] : [];
    });
    const editorial = await generateSocialEditorial({ type, editionDate, canonicalUrl: publicUrl, content, stories: evidence, recentPosts, imageCredit: content.image_credit });
    newEstimatedCost = editorial.estimatedCostUsd;
    const previousSocialCost = Number(stored?.estimated_cost_usd ?? 0);
    const totalEstimatedCost = Number(run.estimated_cost_usd) - previousSocialCost + newEstimatedCost;
    if (totalEstimatedCost > Number(settings.max_estimated_cost_usd)) throw new SocialEditorialValidationError(`The digest and social editorial cost estimate ($${totalEstimatedCost.toFixed(4)}) exceeded the configured $${Number(settings.max_estimated_cost_usd).toFixed(2)} limit.`);
    text = editorial.text;
    socialCopy = {
      channel_ids: channels,
      mode: savedMode,
      text,
      public_url: publicUrl,
      approach: editorial.approach,
      featured_story_ids: editorial.featuredStoryIds,
      hashtags: editorial.hashtags,
      review_decision: editorial.reviewDecision,
      review_issues: editorial.reviewIssues,
      claim_support: editorial.claimSupport,
      model: editorial.model,
      generation_prompt_version: editorial.generationPromptVersion,
      review_prompt_version: editorial.reviewPromptVersion,
      input_tokens: editorial.inputTokens,
      output_tokens: editorial.outputTokens,
      estimated_cost_usd: editorial.estimatedCostUsd,
      generated_at: new Date().toISOString(),
    };
    const { error: copyError } = await supabase.from('digest_runs').update({ social_copy: socialCopy, estimated_cost_usd: totalEstimatedCost }).eq('id', delivery.run_id);
    if (copyError) throw copyError;
    await supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', message: 'Social editorial copy generated and independently reviewed.', details: { approach: editorial.approach, featured_story_ids: editorial.featuredStoryIds, review_decision: editorial.reviewDecision, input_tokens: editorial.inputTokens, output_tokens: editorial.outputTokens, estimated_cost_usd: editorial.estimatedCostUsd } });
  }

  if (storedText) {
    socialCopy = { ...socialCopy, channel_ids: channels, mode: savedMode, public_url: publicUrl };
    const { error: copyError } = await supabase.from('digest_runs').update({ social_copy: socialCopy }).eq('id', delivery.run_id);
    if (copyError) throw copyError;
  }

  // A slow generation may finish after its posting window. Keep its audit copy
  // but never create a backlog of provider deliveries from it.
  assertSocialPostingWindow(run.period_end);
  const rows = channels.map((channelId) => {
    const id = randomUUID();
    const payload = buildSocialDistributionPayload({ deliveryId: id, text: text!, publicUrl, imageUrl: digestStory.image_url, mode });
    return { id, run_id: delivery.run_id, story_id: delivery.story_id, provider: 'buffer' as const, destination: channelId, payload };
  });
  const { error: rowsError } = await supabase.from('digest_deliveries').upsert(rows, { onConflict: 'run_id,provider,destination', ignoreDuplicates: true });
  if (rowsError) throw rowsError;
  return { queued: rows.length, socialCopy, estimatedCostUsd: newEstimatedCost };
}

export async function prepareDigestDistributions(runId: string, storyId: string) {
  const supabase = getSupabaseAdminClient();
  const [{ data: settings, error: settingsError }, { data: story, error: storyError }, { data: run, error: runError }] = await Promise.all([
    supabase.from('digest_settings').select('social_distribution_enabled, social_distribution_mode, email_distribution_enabled, max_estimated_cost_usd').eq('id', true).single(),
    supabase.from('stories').select('id, slug, status, content_type, image_url, image_alt, generation_metadata').eq('id', storyId).single(),
    supabase.from('digest_runs').select('id, estimated_cost_usd, social_copy').eq('id', runId).single(),
  ]);
  if (settingsError || storyError || runError || !settings || !story || !run) throw settingsError ?? storyError ?? runError ?? new Error('Digest distribution could not be prepared.');
  const digestStory = story as DigestStory;
  if (digestStory.status !== 'published') throw new Error('Only a published digest can be distributed.');
  const content = digestStory.generation_metadata.digest_content;
  if (!content) throw new Error('The published digest has no verified distribution content.');
  const { type, editionDate } = editionDetails(digestStory);
  const rows: Array<{ id: string; run_id: string; story_id: string; provider: DeliveryProvider; destination: string; payload: Record<string, unknown> }> = [];
  let socialCopy: Record<string, unknown> = {};
  let emailContent: Record<string, unknown> = {};
  let socialStatus = 'disabled';
  let emailStatus = 'disabled';

  if (settings.social_distribution_enabled) {
    const channels = bufferChannelIds();
    const bufferMode = settings.social_distribution_mode === 'immediate' ? 'shareNow' : 'addToQueue';
    if (!channels.length || !(process.env.BUFFER_API_KEY ?? '').trim()) {
      await recordPreparationFailure(runId, storyId, 'buffer', 'Social distribution is enabled, but BUFFER_API_KEY or BUFFER_CHANNEL_IDS is not configured.');
      socialStatus = 'failed';
    } else {
      const id = randomUUID();
      rows.push({ id, run_id: runId, story_id: storyId, provider: 'buffer', destination: SOCIAL_EDITORIAL_DESTINATION, payload: { kind: SOCIAL_EDITORIAL_DESTINATION, mode: bufferMode } });
      socialCopy = { channel_ids: channels, mode: settings.social_distribution_mode, stage: 'pending' };
      socialStatus = 'pending';
    }
  }

  // The public signup promise is currently a Weekly Digest, so daily editions are not emailed.
  if (settings.email_distribution_enabled && type === 'weekly') {
    try {
      const listId = positiveIntegerEnvironmentValue('BREVO_LIST_ID', process.env.BREVO_LIST_ID);
      positiveIntegerEnvironmentValue('BREVO_SENDER_ID', process.env.BREVO_SENDER_ID);
      if (!(process.env.BREVO_API_KEY ?? '').trim()) throw new Error('BREVO_API_KEY is not configured.');
      const id = randomUUID();
      const payload = buildEmailDistributionPayload({ runId, type, editionDate, content, sources: digestStory.generation_metadata.digest_source_stories ?? [], imageUrl: digestStory.image_url, imageAlt: digestStory.image_alt, listId });
      rows.push({ id, run_id: runId, story_id: storyId, provider: 'brevo', destination: String(listId), payload });
      emailContent = { subject: payload.subject, preview_text: payload.previewText, public_url: payload.publicUrl };
      emailStatus = 'pending';
    } catch (error) {
      await recordPreparationFailure(runId, storyId, 'brevo', `Email distribution is enabled, but Brevo is not fully configured. ${safeError(error)}`);
      emailStatus = 'failed';
    }
  }

  if (rows.length) {
    const { error } = await supabase.from('digest_deliveries').upsert(rows, { onConflict: 'run_id,provider,destination', ignoreDuplicates: true });
    if (error) throw error;
  }
  const hasPending = socialStatus === 'pending' || emailStatus === 'pending';
  await supabase.from('digest_runs').update({
    status: hasPending ? 'distributing' : socialStatus === 'failed' || emailStatus === 'failed' ? 'partial' : 'published',
    social_status: socialStatus,
    email_status: emailStatus,
    social_copy: socialCopy,
    email_content: emailContent,
    estimated_cost_usd: Number(run.estimated_cost_usd),
    completed_at: hasPending ? null : new Date().toISOString(),
  }).eq('id', runId);
  if (hasPending) await supabase.from('digest_run_events').insert({ run_id: runId, stage: 'distribution', message: `${rows.length} external ${rows.length === 1 ? 'delivery is' : 'deliveries are'} ready for the automation heartbeat.` });
  return { queued: rows.length, socialStatus, emailStatus };
}

export async function refreshDigestDistributionStatus(runId: string) {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from('digest_deliveries').select('provider, destination, status').eq('run_id', runId);
  if (error) throw error;
  const deliveries = (data ?? []) as Array<{ provider: DeliveryProvider; destination: string; status: DeliveryStatus }>;
  const summarize = (provider: DeliveryProvider) => {
    const providerRows = deliveries.filter((item) => item.provider === provider);
    const destinations = providerRows.filter((item) => item.destination !== SOCIAL_EDITORIAL_DESTINATION);
    const statuses = (provider === 'buffer' && destinations.length ? destinations : providerRows).map((item) => item.status);
    if (!statuses.length) return null;
    if (statuses.every((status) => status === 'unsent' || status === 'cancelled')) return statuses.includes('unsent') ? 'unsent' : 'disabled';
    if (statuses.every((status) => status === 'submitted' || status === 'completed' || status === 'cancelled')) return provider === 'buffer' ? 'queued' : 'scheduled';
    if (statuses.some((status) => status === 'failed' || status === 'uncertain')) return provider === 'buffer' && statuses.some((status) => status === 'submitted' || status === 'completed') ? 'partial' : 'failed';
    if (statuses.includes('unsent') && !statuses.some((status) => status === 'pending' || status === 'processing')) return 'partial';
    return 'pending';
  };
  const socialStatus = summarize('buffer');
  const emailStatus = summarize('brevo');
  const hasOutstanding = deliveries.some((item) => item.status === 'pending' || item.status === 'processing');
  const hasProblem = deliveries.some((item) => item.status === 'failed' || item.status === 'uncertain');
  const update: Record<string, unknown> = {
    status: hasOutstanding ? 'distributing' : hasProblem ? 'partial' : deliveries.length ? 'completed' : 'published',
    completed_at: hasOutstanding ? null : new Date().toISOString(),
  };
  if (socialStatus) update.social_status = socialStatus;
  if (emailStatus) update.email_status = emailStatus;
  if (!hasProblem) update.error_summary = null;
  await supabase.from('digest_runs').update(update).eq('id', runId);
}

export async function processClaimedDigestDelivery(deliveryId: string, leaseToken: string) {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from('digest_deliveries').select('*').eq('id', deliveryId).eq('lease_token', leaseToken).eq('status', 'processing').maybeSingle();
  if (error || !data) throw error ?? new Error('The claimed digest delivery is no longer available.');
  const delivery = data as DeliveryRecord;
  try {
    if (delivery.provider === 'buffer' && delivery.destination === SOCIAL_EDITORIAL_DESTINATION) {
      let prepared: Awaited<ReturnType<typeof prepareSocialEditorialDeliveries>>;
      try {
        prepared = await prepareSocialEditorialDeliveries(delivery);
      } catch (error) {
        if (error instanceof DistributionProviderError || error instanceof SocialPostingWindowExpired) throw error;
        throw new DistributionProviderError(safeError(error), error instanceof SocialEditorialValidationError ? 'rejected' : 'retryable');
      }
      const completedAt = new Date().toISOString();
      const reference = `validated:${SOCIAL_GENERATION_PROMPT_VERSION}`;
      const { error: editorialUpdateError } = await supabase.from('digest_deliveries').update({ status: 'completed', provider_reference: reference, submitted_at: completedAt, completed_at: completedAt, lease_token: null, lease_expires_at: null, last_error: null }).eq('id', delivery.id).eq('lease_token', leaseToken);
      if (editorialUpdateError) throw editorialUpdateError;
      await supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', message: `${prepared.queued} validated Buffer ${prepared.queued === 1 ? 'delivery is' : 'deliveries are'} ready for the automation heartbeat.`, details: { provider: 'buffer', stage: SOCIAL_EDITORIAL_DESTINATION, deliveries_prepared: prepared.queued } });
      await refreshDigestDistributionStatus(delivery.run_id);
      return { provider: delivery.provider, destination: delivery.destination, providerReference: reference, queued: prepared.queued };
    }

    let providerReference = delivery.provider_reference;
    if (delivery.provider === 'buffer') {
      if (!providerReference) {
        const { data: run, error: runError } = await supabase.from('digest_runs').select('period_end').eq('id', delivery.run_id).single();
        if (runError || !run) throw runError ?? new Error('The social posting window could not be verified.');
        assertSocialPostingWindow(run.period_end);
        providerReference = await createBufferPost(delivery.destination, delivery.payload as unknown as BufferPostPayload);
        const { error: referenceError } = await supabase.from('digest_deliveries').update({ provider_reference: providerReference }).eq('id', delivery.id).eq('lease_token', leaseToken);
        if (referenceError) throw referenceError;
      }
    } else {
      const payload = delivery.payload as unknown as BrevoCampaignPayload;
      if (!providerReference) {
        providerReference = await createBrevoCampaign(payload);
        const { error: referenceError } = await supabase.from('digest_deliveries').update({ provider_reference: providerReference }).eq('id', delivery.id).eq('lease_token', leaseToken);
        if (referenceError) throw referenceError;
      }
      if (!await brevoCampaignIsSubmitted(providerReference)) await sendBrevoCampaign(providerReference);
    }
    const submittedAt = new Date().toISOString();
    const { error: updateError } = await supabase.from('digest_deliveries').update({ status: 'submitted', provider_reference: providerReference, submitted_at: submittedAt, completed_at: submittedAt, lease_token: null, lease_expires_at: null, last_error: null }).eq('id', delivery.id).eq('lease_token', leaseToken);
    if (updateError) throw updateError;
    await supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', message: `${delivery.provider === 'buffer' ? 'Buffer post queued' : 'Brevo campaign scheduled'} successfully.`, details: { provider: delivery.provider, destination: delivery.destination, provider_reference: providerReference } });
    await refreshDigestDistributionStatus(delivery.run_id);
    return { provider: delivery.provider, destination: delivery.destination, providerReference };
  } catch (error) {
    if (error instanceof SocialPostingWindowExpired) {
      const { error: expiryError } = await supabase.from('digest_deliveries').update({
        status: 'unsent', last_error: error.message, completed_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
      }).eq('id', delivery.id).eq('lease_token', leaseToken).eq('status', 'processing');
      if (expiryError) throw expiryError;
      await supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', level: 'info', message: error.message, details: { provider: 'buffer', delivery_id: delivery.id } });
      await refreshDigestDistributionStatus(delivery.run_id);
      return { provider: delivery.provider, destination: delivery.destination, status: 'unsent' };
    }
    const providerError = error instanceof DistributionProviderError ? error : new DistributionProviderError(safeError(error), 'uncertain');
    const retryable = providerError.outcome === 'retryable' && delivery.attempt_count < 3;
    const status = retryable ? 'pending' : providerError.outcome === 'uncertain' ? 'uncertain' : 'failed';
    const nextAttemptAt = new Date(Date.now() + Math.min(30, 2 ** delivery.attempt_count) * 60_000).toISOString();
    await Promise.all([
      supabase.from('digest_deliveries').update({ status, next_attempt_at: nextAttemptAt, lease_token: null, lease_expires_at: null, last_error: safeError(providerError) }).eq('id', delivery.id).eq('lease_token', leaseToken),
      supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', level: retryable ? 'warning' : 'error', message: safeError(providerError), details: { provider: delivery.provider, destination: delivery.destination, outcome: providerError.outcome } }),
    ]);
    await refreshDigestDistributionStatus(delivery.run_id);
    return { provider: delivery.provider, destination: delivery.destination, error: 'External delivery failed.', status };
  }
}

