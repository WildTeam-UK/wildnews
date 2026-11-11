-- A completed or budget-stopped run must durably hand off its usable drafts.
-- Historical runs are retained, never republished by this recovery mechanism.
alter table public.editorial_runs add column publication_queue_completed_at timestamptz;
update public.editorial_runs
set publication_queue_completed_at = now()
where status <> 'running'
  and timezone('Europe/London', started_at)::date < timezone('Europe/London', now())::date;

create or replace function public.renew_editorial_run_step(
  target_run_id uuid, target_lease_token uuid, lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.editorial_runs
  set step_lease_until = now() + make_interval(secs => greatest(30, least(lease_seconds, 300)))
  where id = target_run_id and status = 'running'
    and step_lease_token = target_lease_token and step_lease_until > now();
  return found;
end;
$$;

-- Selection and its stage transition are one transaction. A late worker cannot
-- append a second initial shortlist, even if its AI response arrives later.
create or replace function public.select_editorial_run_candidates(
  target_run_id uuid, target_lease_token uuid, candidate_ids uuid[], initial_selection boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.editorial_runs%rowtype;
  capacity integer;
  next_rank integer;
  selected_count integer;
begin
  select * into run from public.editorial_runs where id = target_run_id for update;
  if run.id is null or run.status <> 'running'
    or run.step_lease_token is distinct from target_lease_token
    or run.step_lease_until is null or run.step_lease_until <= now() then
    raise exception 'Editorial step lease is no longer active';
  end if;
  if timezone('Europe/London', run.started_at)::date <> timezone('Europe/London', now())::date then
    raise exception 'Editorial run belongs to a previous London day';
  end if;
  if initial_selection and run.current_stage <> 'assessing' then return 0; end if;
  if not initial_selection and run.current_stage <> 'researching' then return 0; end if;

  select greatest(0, run.max_new_drafts - count(*) filter (where status <> 'failed')),
         coalesce(max(rank), 0) + 1
  into capacity, next_rank
  from public.editorial_run_items where run_id = target_run_id;

  insert into public.editorial_run_items (run_id, cluster_id, rank, status)
  select target_run_id, candidate.id, next_rank + row_number() over (order by candidate.position) - 1, 'pending'
  from (
    select ids.id, min(ids.position) as position
    from unnest(candidate_ids) with ordinality as ids(id, position)
    where not exists (select 1 from public.editorial_run_items item where item.run_id = target_run_id and item.cluster_id = ids.id)
    group by ids.id
    order by min(ids.position)
    limit capacity
  ) candidate;
  get diagnostics selected_count = row_count;
  update public.editorial_runs
  set current_stage = 'researching',
      candidates_selected = (select count(*) from public.editorial_run_items where run_id = target_run_id)
  where id = target_run_id;
  return selected_count;
end;
$$;

-- Serialize claims against the daily settings row. Count actual published news
-- and outstanding publication claims so overlapping heartbeats cannot exceed
-- the daily target. Digests are deliberately excluded from the article count.
create or replace function public.claim_due_publication()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  settings public.editorial_run_settings%rowtype;
  local_now timestamp := timezone('Europe/London', now());
  day_start timestamptz := local_now::date at time zone 'Europe/London';
  day_end timestamptz := (local_now::date + 1) at time zone 'Europe/London';
  occupied integer;
  queue_id uuid;
begin
  select * into settings from public.editorial_run_settings where id = true for update;
  if not settings.auto_publish_enabled then return null; end if;

  update public.publication_queue queue
  set status = 'published', published_at = story.published_at, claimed_at = null, hold_reason = null
  from public.stories story
  where queue.story_id = story.id and story.status = 'published' and queue.status <> 'published';

  update public.publication_queue
  set status = 'scheduled', claimed_at = null, last_error = 'Recovered after an interrupted publication request.'
  where status = 'publishing' and claimed_at < now() - interval '5 minutes';

  update public.publication_queue queue
  set status = 'cancelled', scheduled_for = null, claimed_at = null,
      hold_reason = 'The London publication day ended. The article remains private for editorial review.'
  where queue.status in ('queued', 'scheduled')
    and (queue.scheduled_for < day_start or (queue.source_run_id is not null and exists (
      select 1 from public.editorial_runs run where run.id = queue.source_run_id
        and timezone('Europe/London', run.started_at)::date < local_now::date
    )));

  if local_now::time < settings.publish_window_start or local_now::time >= settings.publish_window_end then return null; end if;

  select count(*) into occupied from public.stories
  where content_type = 'news' and status = 'published' and published_at >= day_start and published_at < day_end;
  occupied := occupied + (select count(*) from public.publication_queue where status = 'publishing');
  if occupied >= settings.max_new_drafts then return null; end if;

  select id into queue_id from public.publication_queue
  where status = 'scheduled' and scheduled_for >= day_start and scheduled_for <= now()
  order by scheduled_for, created_at for update skip locked limit 1;
  if queue_id is null then return null; end if;
  update public.publication_queue
  set status = 'publishing', claimed_at = now(), attempt_count = attempt_count + 1
  where id = queue_id;
  return queue_id;
end;
$$;

revoke all on function public.renew_editorial_run_step(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.select_editorial_run_candidates(uuid, uuid, uuid[], boolean) from public, anon, authenticated;
revoke all on function public.claim_due_publication() from public, anon, authenticated;
grant execute on function public.renew_editorial_run_step(uuid, uuid, integer) to service_role;
grant execute on function public.select_editorial_run_candidates(uuid, uuid, uuid[], boolean) to service_role;
grant execute on function public.claim_due_publication() to service_role;
