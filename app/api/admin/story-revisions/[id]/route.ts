import { unexpectedErrorResponse } from '@/lib/api-errors';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyEditorialRevision } from '@/lib/coverage-revision-workflow';
import { cleanDraftContent, type StoryDraftContent } from '@/lib/openai/draft-story';
import { revisionChangesPublicContent } from '@/lib/openai/generate-editorial-revision';
import { requireApiAdmin } from '@/lib/supabase/require-api-admin';
import { normalizeEditorialTopics } from '@/lib/taxonomy';
import { isUuid } from '@/lib/validation';

export const dynamic = 'force-dynamic';

type StoredSource = { id?: string };

async function loadDraftRevision(supabase: SupabaseClient, id: string) {
  return supabase.from('story_editorial_revisions').select('id, story_id, status, base_content, proposed_content, source_list, public_content_changed').eq('id', id).maybeSingle();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid editorial revision is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { supabase } = auth;
  const body = await request.json().catch(() => null) as { content?: StoryDraftContent } | null;
  if (!body?.content) return Response.json({ error: 'Revision content is required.' }, { status: 400 });

  try {
    const { data: revision, error: revisionError } = await loadDraftRevision(supabase, id);
    if (revisionError) throw revisionError;
    if (!revision) return Response.json({ error: 'Editorial revision not found.' }, { status: 404 });
    if (revision.status !== 'draft') return Response.json({ error: 'Only a draft revision can be edited.' }, { status: 409 });
    const validSourceIds = new Set(((revision.source_list ?? []) as StoredSource[]).flatMap((source) => source.id ? [source.id] : []));
    const baseContent = revision.base_content as StoryDraftContent;
    const content = cleanDraftContent({ ...body.content, template_version: baseContent.template_version === 3 ? 3 : 2, topics: normalizeEditorialTopics(body.content.topics ?? []) }, validSourceIds);
    const { error } = await supabase.from('story_editorial_revisions').update({ proposed_content: content, public_content_changed: revisionChangesPublicContent(baseContent, content) }).eq('id', id).eq('status', 'draft');
    if (error) throw error;
    return Response.json({ saved: true });
  } catch (error) {
    return unexpectedErrorResponse('Editorial revision save failed', error, 'The editorial revision could not be saved.');
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid editorial revision is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { supabase } = auth;
  try {
    return Response.json(await applyEditorialRevision(supabase, id));
  } catch (error) {
    return unexpectedErrorResponse('Editorial revision apply failed', error, 'The revision was not applied. Its public update summary can be generated again when you retry.');
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid editorial revision is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { supabase } = auth;

  try {
    const { data: links, error: linksError } = await supabase.from('story_editorial_revision_updates').select('update_id').eq('revision_id', id);
    if (linksError) throw linksError;
    const { error } = await supabase.from('story_editorial_revisions').update({ status: 'discarded', discarded_at: new Date().toISOString() }).eq('id', id).eq('status', 'draft');
    if (error) throw error;
    const updateIds = (links ?? []).map((link) => link.update_id);
    if (updateIds.length) {
      const { error: updateError } = await supabase.from('story_cluster_updates').update({ status: 'pending_review' }).in('id', updateIds).eq('status', 'in_revision');
      if (updateError) throw updateError;
    }
    return Response.json({ discarded: true });
  } catch (error) {
    return unexpectedErrorResponse('Editorial revision discard failed', error, 'The editorial revision could not be discarded.');
  }
}
