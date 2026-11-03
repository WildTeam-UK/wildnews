import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { getPublishedStories } from '@/lib/published-stories';
import { getPublicCacheStore } from '@/lib/public-cache-store';

export const dynamic = 'force-dynamic';

const HEARTBEAT_STALE_AFTER_MS = 10 * 60_000;

type AutomationSettings = {
  automation_enabled: boolean;
  auto_publish_enabled: boolean;
  last_automation_tick_at: string | null;
  last_automation_error: string | null;
  consecutive_automation_failures: number;
};

type DigestSettings = {
  automation_enabled: boolean;
  social_distribution_enabled: boolean;
  email_distribution_enabled: boolean;
  last_automation_tick_at: string | null;
  last_automation_error: string | null;
  consecutive_automation_failures: number;
};

function isStale(timestamp: string | null) {
  if (!timestamp) return true;
  const age = Date.now() - new Date(timestamp).getTime();
  return !Number.isFinite(age) || age > HEARTBEAT_STALE_AFTER_MS;
}

const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const [editorialResult, digestResult, distributionResult, publicStories, publicPageFailure] = await Promise.all([
      supabase.from('editorial_run_settings').select('automation_enabled, auto_publish_enabled, last_automation_tick_at, last_automation_error, consecutive_automation_failures').eq('id', true).single(),
      supabase.from('digest_settings').select('automation_enabled, social_distribution_enabled, email_distribution_enabled, last_automation_tick_at, last_automation_error, consecutive_automation_failures').eq('id', true).single(),
      supabase.from('digest_deliveries').select('provider, status').in('status', ['failed', 'uncertain']).limit(100),
      getPublishedStories(1),
      Promise.all([getPublicCacheStore().get('render-failure'), getPublicCacheStore().get('invalidation-failure')]).then((failures) => failures.some(Boolean)),
    ]);

    if (editorialResult.error || digestResult.error || distributionResult.error) throw editorialResult.error ?? digestResult.error ?? distributionResult.error;

    const editorial = editorialResult.data as AutomationSettings;
    const digest = digestResult.data as DigestSettings;
    const editorialEnabled = editorial.automation_enabled || editorial.auto_publish_enabled;
    const distributionEnabled = digest.social_distribution_enabled || digest.email_distribution_enabled;
    const heartbeatRequired = editorialEnabled || digest.automation_enabled || distributionEnabled;
    const heartbeatStale = heartbeatRequired && (isStale(editorial.last_automation_tick_at) || isStale(digest.last_automation_tick_at));
    const editorialFailing = editorialEnabled && Boolean(editorial.last_automation_error || editorial.consecutive_automation_failures);
    const digestFailing = digest.automation_enabled && Boolean(digest.last_automation_error || digest.consecutive_automation_failures);
    const distributionFailing = distributionEnabled && (distributionResult.data ?? []).some((delivery) =>
      delivery.provider === 'buffer' ? digest.social_distribution_enabled : digest.email_distribution_enabled
    );
    const publicPagesFailing = !publicStories.length || Boolean(publicPageFailure);
    const ok = !heartbeatStale && !editorialFailing && !digestFailing && !distributionFailing && !publicPagesFailing;

    return Response.json({
      ok,
      checks: {
        database: 'healthy',
        public_pages: publicPagesFailing ? 'failing' : 'healthy',
        scheduler: heartbeatRequired ? heartbeatStale ? 'stale' : 'healthy' : 'idle',
        editorial: editorialEnabled ? editorialFailing ? 'failing' : 'healthy' : 'disabled',
        publishing: editorial.auto_publish_enabled ? 'healthy' : 'disabled',
        digests: digest.automation_enabled ? digestFailing ? 'failing' : 'healthy' : 'disabled',
        distribution: distributionEnabled ? distributionFailing ? 'failing' : 'healthy' : 'disabled',
      },
      checked_at: new Date().toISOString(),
    }, { status: ok ? 200 : 503, headers: responseHeaders });
  } catch (error) {
    console.error('System health check failed', error);
    return Response.json({
      ok: false,
      checks: { database: 'unavailable' },
      checked_at: new Date().toISOString(),
    }, { status: 503, headers: responseHeaders });
  }
}
