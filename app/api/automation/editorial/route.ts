import { timingSafeEqual } from 'node:crypto';
import { processAutomatedCoverageUpdates } from '@/lib/coverage-revision-workflow';
import { environmentValue } from '@/lib/environment';
import { advanceEditorialRun, recoverEditorialRunPublication } from '@/lib/editorial-runner';
import { collectEnabledSources, continueActiveCollection } from '@/lib/ingestion/rss';
import { generateDigest } from '@/lib/openai/generate-digest';
import { processClaimedDigestDelivery } from '@/lib/digest-distribution';
import { publishDigest } from '@/lib/publish-digest';
import { publishClaimedQueueItem } from '@/lib/publication-queue';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const expected = environmentValue(process.env.AUTOMATION_SECRET);
  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!expected || !provided || expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

async function recordHeartbeatSuccess() {
  await getSupabaseAdminClient().from('editorial_run_settings').update({
    last_automation_tick_at: new Date().toISOString(),
    last_automation_error: null,
    consecutive_automation_failures: 0,
  }).eq('id', true);
}

async function recordHeartbeatFailure(detail: string) {
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase.from('editorial_run_settings').select('consecutive_automation_failures').eq('id', true).maybeSingle();
  await supabase.from('editorial_run_settings').update({
    last_automation_tick_at: new Date().toISOString(),
    last_automation_error: detail.slice(0, 1000),
    consecutive_automation_failures: Number(data?.consecutive_automation_failures ?? 0) + 1,
  }).eq('id', true);
}

async function recordDigestSuccess() {
  await getSupabaseAdminClient().from('digest_settings').update({
    last_automation_tick_at: new Date().toISOString(),
    last_automation_error: null,
    consecutive_automation_failures: 0,
  }).eq('id', true);
}

async function recordDigestFailure(runId: string, detail: string) {
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase.from('digest_settings').select('consecutive_automation_failures').eq('id', true).maybeSingle();
  await Promise.all([
    supabase.from('digest_settings').update({
      last_automation_tick_at: new Date().toISOString(),
      last_automation_error: detail.slice(0, 1000),
      consecutive_automation_failures: Number(data?.consecutive_automation_failures ?? 0) + 1,
    }).eq('id', true),
    supabase.from('digest_runs').update({ status: 'failed', error_summary: detail.slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', runId),
    supabase.from('digest_run_events').insert({ run_id: runId, stage: 'automation', level: 'error', message: detail.slice(0, 1000) }),
  ]);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return Response.json({ error: 'Automation authorization failed.' }, { status: 401 });

  const supabase = getSupabaseAdminClient();
  try {
    await recoverEditorialRunPublication();
    const { data: duePublication, error: publicationClaimError } = await supabase.rpc('claim_due_publication');
    if (publicationClaimError) throw publicationClaimError;
    const publication = duePublication ? await publishClaimedQueueItem(duePublication) : null;

    const { data: digestClaimRows, error: digestClaimError } = await supabase.rpc('claim_due_digest_run');
    const digestFunctionMissing = digestClaimError && ['PGRST202', '42883'].includes(digestClaimError.code ?? '');
    if (digestClaimError && !digestFunctionMissing) throw digestClaimError;
    const digestClaim = Array.isArray(digestClaimRows) ? digestClaimRows[0] : null;
    if (digestClaim?.claimed_run_id) {
      try {
        await supabase.from('digest_run_events').insert({
          run_id: digestClaim.claimed_run_id,
          stage: digestClaim.is_recovery ? 'retry' : 'automation',
          message: digestClaim.is_recovery ? 'Interrupted scheduled digest recovered by the automation heartbeat.' : `Scheduled ${digestClaim.claimed_digest_type} digest claimed automatically.`,
        });
        const generated = await generateDigest(digestClaim.claimed_digest_type, null, {
          periodStart: digestClaim.claimed_period_start,
          periodEnd: digestClaim.claimed_period_end,
          triggerType: digestClaim.is_recovery ? 'retry' : 'scheduled',
        });
        if (generated.runId !== digestClaim.claimed_run_id) {
          await supabase.from('digest_runs').update({ status: 'skipped', story_id: generated.storyId, completed_at: new Date().toISOString(), error_summary: 'An edition for this London calendar date already existed.' }).eq('id', digestClaim.claimed_run_id);
        }
        const digestPublication = digestClaim.should_publish && generated.storyId
          ? await publishDigest(generated.storyId, { reviewerId: null, automated: true })
          : null;
        await recordDigestSuccess();
        await recordHeartbeatSuccess();
        return Response.json({ action: digestPublication ? 'digest_published' : 'digest_generated', publication, digest: generated, digestPublication });
      } catch (digestError) {
        const detail = digestError instanceof Error ? digestError.message : 'Scheduled digest generation failed.';
        await recordDigestFailure(digestClaim.claimed_run_id, detail);
        await recordHeartbeatSuccess();
        console.error('Digest automation failed', digestError);
        return Response.json({ action: 'digest_failed', publication, digestError: 'Scheduled digest generation failed.' });
      }
    }

    const { data: deliveryClaimRows, error: deliveryClaimError } = await supabase.rpc('claim_due_digest_delivery', { lease_seconds: 90 });
    const deliveryFunctionMissing = deliveryClaimError && ['PGRST202', '42883'].includes(deliveryClaimError.code ?? '');
    if (deliveryClaimError && !deliveryFunctionMissing) throw deliveryClaimError;
    const deliveryClaim = Array.isArray(deliveryClaimRows) ? deliveryClaimRows[0] : null;
    const distribution = deliveryClaim?.delivery_id && deliveryClaim.delivery_lease_token
      ? await processClaimedDigestDelivery(deliveryClaim.delivery_id, deliveryClaim.delivery_lease_token)
      : null;
    if (distribution) {
      await recordHeartbeatSuccess();
      return Response.json({ action: 'distributed', publication, distribution });
    }

    const { data, error } = await supabase.rpc('claim_due_editorial_run');
    if (error) throw error;
    const claim = Array.isArray(data) ? data[0] : null;

    if (claim?.claimed_run_id) {
      if (claim.newly_started) {
        await supabase.from('editorial_run_events').insert({
          run_id: claim.claimed_run_id,
          stage: 'run',
          level: 'info',
          message: 'Scheduled editorial run started automatically.',
          details: { trigger: 'supabase_cron' },
        });
      }
      const snapshot = await advanceEditorialRun(claim.claimed_run_id, null);
      await recordHeartbeatSuccess();
      return Response.json({ action: claim.newly_started ? 'started' : 'advanced', publication, snapshot });
    }

    const coverageUpdate = await processAutomatedCoverageUpdates(supabase);
    if (coverageUpdate) {
      await recordHeartbeatSuccess();
      return Response.json({ action: coverageUpdate.action, publication, coverageUpdate });
    }

    const activeCollection = await continueActiveCollection();
    if (activeCollection) {
      await recordHeartbeatSuccess();
      return Response.json({ action: 'collection_advanced', publication, result: activeCollection });
    }

    const { data: collect, error: collectClaimError } = await supabase.rpc('claim_periodic_collection', { interval_hours: 2 });
    if (collectClaimError) throw collectClaimError;
    if (collect) {
      const result = await collectEnabledSources('scheduled');
      await recordHeartbeatSuccess();
      return Response.json({ action: 'collected', publication, result });
    }

    const { data: payloadsPruned, error: retentionError } = await supabase.rpc('prune_source_item_payloads', { batch_size: 250 });
    if (retentionError) throw retentionError;

    await recordHeartbeatSuccess();
    return Response.json({
      action: publication ? 'published' : Number(payloadsPruned ?? 0) > 0 ? 'retention_pruned' : 'idle',
      publication,
      payloadsPruned: Math.max(0, Number(payloadsPruned ?? 0)),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown automation error.';
    await recordHeartbeatFailure(detail);
    console.error('Editorial automation heartbeat failed', error);
    return Response.json({ error: 'Editorial automation heartbeat failed.' }, { status: 500 });
  }
}
