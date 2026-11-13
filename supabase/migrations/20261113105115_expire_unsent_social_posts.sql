-- Two hours from the edition's scheduled time, not its delayed generation or
-- retry time. Buffer-accepted and uncertain outcomes are never replayed or
-- reclassified as unsent. Weekly email delivery retains its existing policy.
alter table public.digest_deliveries drop constraint digest_deliveries_status_check;
alter table public.digest_deliveries add constraint digest_deliveries_status_check
  check (status in ('pending','processing','submitted','completed','failed','uncertain','cancelled','unsent'));
alter table public.digest_runs drop constraint digest_runs_social_status_check;
alter table public.digest_runs add constraint digest_runs_social_status_check
  check (social_status in ('disabled','pending','ready','queued','published','partial','failed','unsent'));

create or replace function private.expire_digest_social_deliveries()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  expired record;
  expired_count integer := 0;
begin
  for expired in
    update public.digest_deliveries d
    set status = 'unsent',
      last_error = 'Unsent: the two-hour social posting window has closed.',
      completed_at = now(), lease_token = null, lease_expires_at = null
    from public.digest_runs r
    where r.id = d.run_id and d.provider = 'buffer'
      and d.status in ('pending','failed')
      and d.provider_reference is null and d.submitted_at is null
      and r.period_end + interval '2 hours' <= now()
    returning d.id, d.run_id
  loop
    expired_count := expired_count + 1;
    insert into public.digest_run_events(run_id, stage, level, message, details)
      values(expired.run_id, 'distribution', 'info',
        'Unsent: the two-hour social posting window has closed.',
        jsonb_build_object('provider','buffer','delivery_id',expired.id,'window_hours',2));

    update public.digest_runs r set
      social_status = case
        when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.provider='buffer' and d.status in ('failed','uncertain')) then 'failed'
        when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.provider='buffer' and d.status in ('pending','processing')) then 'pending'
        when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.provider='buffer' and d.destination<>'social-editorial' and d.status in ('submitted','completed')) then 'partial'
        else 'unsent' end,
      status = case
        when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.status in ('pending','processing')) then 'distributing'
        when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.status in ('failed','uncertain')) then 'partial'
        else 'completed' end,
      completed_at = case when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.status in ('pending','processing')) then null else now() end,
      error_summary = case when exists(select 1 from public.digest_deliveries d where d.run_id=r.id and d.status in ('failed','uncertain')) then r.error_summary else null end
    where r.id=expired.run_id;
  end loop;
  return expired_count;
end;
$function$;

revoke all on function private.expire_digest_social_deliveries() from public, anon, authenticated;
grant execute on function private.expire_digest_social_deliveries() to service_role;

create or replace function public.claim_due_digest_delivery(lease_seconds integer default 90)
returns table (delivery_id uuid, delivery_lease_token uuid)
language plpgsql
security definer
set search_path = public
as $function$
declare
  claimed_id uuid;
  claimed_token uuid := gen_random_uuid();
begin
  perform private.expire_digest_social_deliveries();
  -- An expired processing lease may have reached its provider. Keep the
  -- existing uncertain-outcome safeguard even when its posting window passed.
  update public.digest_runs set status='partial',
    error_summary='An external delivery has an uncertain provider outcome.', completed_at=now()
  where id in (select run_id from public.digest_deliveries where status='processing' and lease_expires_at<now());
  update public.digest_deliveries set status='uncertain',
    last_error=coalesce(last_error,'Delivery claim expired before the provider result was recorded.'),
    lease_token=null, lease_expires_at=null
  where status='processing' and lease_expires_at<now();

  select d.id into claimed_id from public.digest_deliveries d
  where d.status='pending' and d.next_attempt_at<=now()
    and exists(select 1 from public.digest_settings s where s.id
      and ((d.provider='buffer' and s.social_distribution_enabled) or (d.provider='brevo' and s.email_distribution_enabled)))
  order by d.next_attempt_at,d.created_at for update skip locked limit 1;
  if claimed_id is null then return; end if;
  update public.digest_deliveries set status='processing',attempt_count=attempt_count+1,
    lease_token=claimed_token,
    lease_expires_at=now()+make_interval(secs=>greatest(30,least(lease_seconds,300))),last_error=null
  where id=claimed_id;
  return query select claimed_id,claimed_token;
end;
$function$;
revoke all on function public.claim_due_digest_delivery(integer) from public, anon, authenticated;
grant execute on function public.claim_due_digest_delivery(integer) to service_role;

-- Expire stale posts every minute without starting an otherwise idle Vercel
-- worker. Keep the existing due-work selector and real health probes intact.
do $migration$
declare heartbeat record;
begin
  select jobid,command into heartbeat from cron.job where jobname='wildnews-editorial-heartbeat';
  if not found then raise exception 'WildNews heartbeat is not configured'; end if;
  if position('private.expire_digest_social_deliveries()' in heartbeat.command)=0 then
    perform cron.alter_job(heartbeat.jobid, command := 'select private.expire_digest_social_deliveries();' || heartbeat.command);
  end if;
end;
$migration$;
