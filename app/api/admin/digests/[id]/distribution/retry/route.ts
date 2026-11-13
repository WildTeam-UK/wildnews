import { requireApiAdmin } from '@/lib/supabase/require-api-admin';
import { isUuid } from '@/lib/validation';
import { SOCIAL_EDITORIAL_DESTINATION } from '@/lib/distribution/constants';
import { socialPostingWindowExpired, SOCIAL_POST_WINDOW_MESSAGE } from '@/lib/distribution/social-window';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: storyId } = await params;
  if (!isUuid(storyId)) return Response.json({ error: 'A valid digest is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null) as { deliveryId?: string; confirmUncertain?: boolean } | null;
  if (!body?.deliveryId || !isUuid(body.deliveryId)) return Response.json({ error: 'A valid delivery is required.' }, { status: 400 });
  const { data: delivery, error } = await auth.supabase.from('digest_deliveries').select('id, run_id, provider, destination, status').eq('id', body.deliveryId).eq('story_id', storyId).maybeSingle();
  if (error || !delivery) return Response.json({ error: 'The delivery could not be found.' }, { status: 404 });
  if (!['failed', 'uncertain'].includes(delivery.status)) return Response.json({ error: 'Only a failed or uncertain delivery can be retried.' }, { status: 409 });
  if (delivery.provider === 'buffer') {
    const { data: run, error: runError } = await auth.supabase.from('digest_runs').select('period_end').eq('id', delivery.run_id).single();
    if (runError || !run) return Response.json({ error: 'The social posting window could not be verified.' }, { status: 500 });
    if (socialPostingWindowExpired(run.period_end)) return Response.json({ error: SOCIAL_POST_WINDOW_MESSAGE }, { status: 409 });
  }
  if (delivery.status === 'uncertain' && delivery.destination !== SOCIAL_EDITORIAL_DESTINATION && body.confirmUncertain !== true) return Response.json({ error: 'Confirm the duplicate-delivery risk before retrying an uncertain provider outcome.' }, { status: 409 });
  const { error: updateError } = await auth.supabase.from('digest_deliveries').update({ status: 'pending', next_attempt_at: new Date().toISOString(), lease_token: null, lease_expires_at: null, last_error: null }).eq('id', delivery.id).in('status', ['failed', 'uncertain']);
  if (updateError) return Response.json({ error: 'The delivery could not be queued for retry.' }, { status: 500 });
  await Promise.all([
    auth.supabase.from('digest_runs').update({ status: 'distributing', completed_at: null, error_summary: null }).eq('id', delivery.run_id),
    auth.supabase.from('digest_run_events').insert({ run_id: delivery.run_id, stage: 'distribution', message: `An editor queued the ${delivery.provider} delivery for retry.`, details: { provider: delivery.provider, destination: delivery.destination, delivery_id: delivery.id } }),
  ]);
  return Response.json({ queued: true });
}

