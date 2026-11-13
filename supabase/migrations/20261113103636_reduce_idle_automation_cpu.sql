-- Applied version matches the hosted Supabase migration history.
-- Keep the minute scheduler and all existing claims/leases. Avoid starting a
-- Vercel worker when no work can be due; a four-minute probe still verifies the
-- actual worker and keeps the existing ten-minute health threshold meaningful.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create or replace function private.wildnews_automation_due()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    not exists (select 1 from public.editorial_run_settings where id)
    or not exists (select 1 from public.digest_settings where id)
    or exists (
      select 1 from public.editorial_run_settings s where s.id and (
        s.last_automation_tick_at is null
        or s.last_automation_tick_at <= now() - interval '4 minutes'
        or (s.automation_enabled and (
          (timezone(s.automation_timezone, now())::time >= s.daily_run_time
            and s.last_scheduled_date is distinct from timezone(s.automation_timezone, now())::date)
          or s.last_periodic_collection_at is null
          or s.last_periodic_collection_at <= now() - interval '2 hours'
        ))
        or (s.auto_publish_enabled and exists (
          select 1 from public.publication_queue q
          where (q.status in ('queued', 'scheduled') and q.scheduled_for <= now())
             or q.status = 'publishing'
        ))
        or (s.auto_coverage_updates_enabled and (
          exists (select 1 from public.story_cluster_updates u
            where u.status = 'processing'
              or (u.status = 'pending_review' and u.automation_attempt_count < 3
                and (u.automation_next_attempt_at is null or u.automation_next_attempt_at <= now())))
          or exists (select 1 from public.story_editorial_revisions r
            where r.status = 'draft' and r.created_by is null and r.automation_attempt_count < 3
              and (r.automation_next_attempt_at is null or r.automation_next_attempt_at <= now()))
        ))
      )
    )
    or exists (select 1 from public.editorial_runs r where r.status = 'running'
      or (r.status in ('completed', 'partial', 'budget_stopped') and r.publication_queue_completed_at is null))
    or exists (select 1 from public.ingestion_runs r where r.status in ('queued', 'collecting'))
    or exists (
      select 1 from public.digest_settings s where s.id and (
        s.last_automation_tick_at is null
        or s.last_automation_tick_at <= now() - interval '4 minutes'
        or (s.automation_enabled and timezone(s.automation_timezone, now())::time >= s.run_time and not exists (
          select 1 from public.digest_runs r
          where r.digest_type = case when extract(isodow from timezone(s.automation_timezone, now()))::integer = s.weekly_day then 'weekly' else 'daily' end
            and r.period_end = (timezone(s.automation_timezone, now())::date + s.run_time) at time zone s.automation_timezone
            and not (r.status = 'generated' and s.publish_immediately and r.story_id is not null)
            and not (r.status in ('queued', 'generating', 'publishing') and r.updated_at < now() - interval '15 minutes')
        ))
        or exists (select 1 from public.digest_deliveries d
          where (d.status = 'processing' and d.lease_expires_at < now())
            or (d.status = 'pending' and d.next_attempt_at <= now()
              and ((d.provider = 'buffer' and s.social_distribution_enabled)
                or (d.provider = 'brevo' and s.email_distribution_enabled))))
      )
    )
    or not exists (select 1 from public.data_retention_runs r
      where (r.status = 'completed' and r.created_at >= now() - interval '24 hours')
         or (r.status = 'failed' and r.created_at >= now() - interval '1 hour'));
$function$;

revoke all on function private.wildnews_automation_due() from public, anon, authenticated;
grant execute on function private.wildnews_automation_due() to service_role;

-- Retain the existing URL, Vault reference, authentication and request timeout.
do $migration$
declare
  heartbeat record;
  gated_command text;
begin
  select jobid, command into heartbeat from cron.job where jobname = 'wildnews-editorial-heartbeat';
  if not found then raise exception 'WildNews heartbeat is not configured'; end if;
  if position('private.wildnews_automation_due()' in heartbeat.command) > 0 then return; end if;
  gated_command := regexp_replace(heartbeat.command, 'as request_id\s*;',
    'as request_id where private.wildnews_automation_due();');
  if gated_command = heartbeat.command then raise exception 'Unrecognised WildNews heartbeat command'; end if;
  perform cron.alter_job(heartbeat.jobid, command := gated_command);
end;
$migration$;
