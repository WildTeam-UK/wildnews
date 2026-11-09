-- Format future version 3 revisions without rewriting existing editorial records.
-- The original version 2 path, permissions, row locks and audit history are preserved.
create or replace function public.apply_story_editorial_revision(target_revision_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  revision public.story_editorial_revisions%rowtype;
  story public.stories%rowtype;
  applied_time timestamptz := now();
  topic_name text;
  source_record jsonb;
  source_position integer;
  primary_topic uuid;
begin
  if not public.is_content_admin() then
    raise exception 'Content administrator access is required.' using errcode = '42501';
  end if;

  select * into revision
  from public.story_editorial_revisions
  where id = target_revision_id
  for update;

  if revision.id is null then
    raise exception 'Editorial revision not found.' using errcode = 'P0002';
  end if;

  if revision.status <> 'draft' then
    raise exception 'Only a draft editorial revision can be applied.' using errcode = 'P0001';
  end if;

  if char_length(trim(coalesce(revision.change_summary, ''))) < 20 then
    raise exception 'A public change summary of at least 20 characters is required.' using errcode = '22023';
  end if;

  select * into story
  from public.stories
  where id = revision.story_id
  for update;

  if story.id is null then
    raise exception 'Story not found.' using errcode = 'P0002';
  end if;

  if nullif(trim(revision.proposed_content ->> 'headline'), '') is null
     or nullif(trim(revision.proposed_content ->> 'standfirst'), '') is null then
    raise exception 'The proposed revision must include a headline and standfirst.' using errcode = '22023';
  end if;

  select topics.id into primary_topic
  from jsonb_array_elements_text(coalesce(revision.proposed_content -> 'topics', '[]'::jsonb)) with ordinality selected(name, position)
  join public.topics on topics.name = selected.name and topics.active = true
  order by selected.position
  limit 1;

  update public.stories
  set headline = revision.proposed_content ->> 'headline',
      standfirst = revision.proposed_content ->> 'standfirst',
      overview = (
        select string_agg(item ->> 'text', E'\n\n' order by position)
        from jsonb_array_elements(coalesce(revision.proposed_content -> 'story_at_a_glance', '[]'::jsonb)) with ordinality paragraphs(item, position)
      ),
      body = case when revision.proposed_content ->> 'template_version' = '3' then
        concat_ws(E'\n\n',
          'Why this matters' || E'\n' || coalesce(revision.proposed_content #>> '{why_it_matters,text}', ''),
          'What happens next' || E'\n' || coalesce(revision.proposed_content #>> '{what_happens_next,text}', ''),
          case when jsonb_array_length(coalesce(revision.proposed_content -> 'what_we_dont_know', '[]'::jsonb)) > 0 then
            'What''s still unclear' || E'\n' || (select string_agg(item ->> 'text', E'\n' order by position) from jsonb_array_elements(revision.proposed_content -> 'what_we_dont_know') with ordinality unknowns(item, position))
          end
        )
      else
        concat_ws(E'\n\n',
        'Why this matters' || E'\n' || coalesce(revision.proposed_content #>> '{why_it_matters,text}', ''),
        'What happens next' || E'\n' || coalesce(revision.proposed_content #>> '{what_happens_next,text}', ''),
        'What we know' || E'\n' || coalesce((select string_agg(item ->> 'text', E'\n' order by position) from jsonb_array_elements(coalesce(revision.proposed_content -> 'what_we_know', '[]'::jsonb)) with ordinality known(item, position)), ''),
        'What we don''t know' || E'\n' || coalesce((select string_agg(item ->> 'text', E'\n' order by position) from jsonb_array_elements(coalesce(revision.proposed_content -> 'what_we_dont_know', '[]'::jsonb)) with ordinality unknowns(item, position)), '')
      )
      end,
      key_takeaways = coalesce(revision.proposed_content -> 'key_takeaways', '[]'::jsonb),
      why_it_matters = revision.proposed_content #>> '{why_it_matters,text}',
      agreed_points = coalesce(revision.proposed_content -> 'what_we_know', '[]'::jsonb),
      disputed_points = coalesce(revision.proposed_content -> 'what_we_dont_know', '[]'::jsonb),
      open_questions = coalesce((
        select jsonb_agg(to_jsonb(item ->> 'text') order by position)
        from jsonb_array_elements(coalesce(revision.proposed_content -> 'what_we_dont_know', '[]'::jsonb)) with ordinality questions(item, position)
      ), '[]'::jsonb),
      image_url = nullif(revision.proposed_content ->> 'image_url', ''),
      image_alt = nullif(revision.proposed_content ->> 'image_alt', ''),
      reviewer_id = auth.uid(),
      primary_topic_id = primary_topic,
      taxonomy_review_required = primary_topic is null,
      taxonomy_review_reason = case when primary_topic is null then 'Choose at least one controlled topic.' else null end,
      taxonomy_confidence = case when primary_topic is null then 0 else 100 end,
      generation_metadata = jsonb_set(
        jsonb_set(
          jsonb_set(story.generation_metadata, '{article_content}', revision.proposed_content, true),
          '{source_ids}', revision.source_list, true
        ),
        '{topic_classification}',
        coalesce(story.generation_metadata -> 'topic_classification', '{}'::jsonb) || jsonb_build_object(
          'primary_topic', revision.proposed_content #>> '{topics,0}',
          'secondary_topics', coalesce(revision.proposed_content -> 'topics', '[]'::jsonb) - 0,
          'confidence', case when primary_topic is null then 0 else 100 end,
          'review_required', primary_topic is null,
          'review_reason', case when primary_topic is null then 'Choose at least one controlled topic.' else '' end
        ),
        true
      ),
      editorial_updated_at = case when story.published_at is not null then applied_time else null end,
      editorial_change_summary = case when story.published_at is not null then trim(revision.change_summary) else null end
  where id = story.id;

  delete from public.story_topics where story_id = story.id;

  for topic_name in
    select selected.name
    from jsonb_array_elements_text(coalesce(revision.proposed_content -> 'topics', '[]'::jsonb)) with ordinality selected(name, position)
    join public.topics on topics.name = selected.name and topics.active = true
    order by selected.position
  loop
    insert into public.story_topics (story_id, topic_id)
    select story.id, topics.id from public.topics where topics.name = topic_name and topics.active = true
    on conflict do nothing;
  end loop;

  source_position := 0;
  for source_record in select value from jsonb_array_elements(revision.source_list)
  loop
    source_position := source_position + 1;
    insert into public.story_sources (
      story_id, source_item_id, source_name, source_title, source_url, source_published_at, source_role, display_order
    ) values (
      story.id,
      case when coalesce(source_record ->> 'source_item_id', '') ~* '^[0-9a-f-]{36}$' then (source_record ->> 'source_item_id')::uuid else null end,
      coalesce(nullif(source_record ->> 'publisher', ''), 'Source'),
      coalesce(nullif(source_record ->> 'title', ''), 'Source coverage'),
      source_record ->> 'url',
      nullif(source_record ->> 'published_at', '')::timestamptz,
      case when source_record ->> 'source_type' = 'primary' then 'primary' else 'supporting' end,
      source_position
    )
    on conflict (story_id, source_url) do update
      set source_name = excluded.source_name,
          source_title = excluded.source_title,
          source_item_id = coalesce(excluded.source_item_id, public.story_sources.source_item_id),
          source_published_at = coalesce(excluded.source_published_at, public.story_sources.source_published_at),
          source_role = excluded.source_role,
          display_order = excluded.display_order;
  end loop;

  update public.story_cluster_updates coverage_update
  set status = 'incorporated',
      reviewed_at = applied_time,
      reviewed_by = auth.uid()
  from public.story_editorial_revision_updates link
  where link.revision_id = revision.id
    and coverage_update.id = link.update_id;

  update public.story_editorial_revisions
  set status = 'applied',
      applied_by = auth.uid(),
      applied_at = applied_time
  where id = revision.id;

  insert into public.editorial_actions (story_id, user_id, action, notes, changes)
  values (
    story.id,
    auth.uid(),
    'edited',
    case when story.published_at is not null then 'Editorial coverage update applied without changing the original publication date.' else 'Coverage update incorporated before first publication.' end,
    jsonb_build_object('revision_id', revision.id, 'change_summary', trim(revision.change_summary), 'published_at_preserved', story.published_at)
  );

  return story.id;
end;
$$;

revoke all on function public.apply_story_editorial_revision(uuid) from public, anon;
grant execute on function public.apply_story_editorial_revision(uuid) to authenticated, service_role;
