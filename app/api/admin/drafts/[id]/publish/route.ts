import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireApiAdmin } from '@/lib/supabase/require-api-admin';
import type { StoryDraftContent } from '@/lib/openai/draft-story';
import { publicationChecks } from '@/lib/publishing';
import { runTaxonomyGovernance } from '@/lib/taxonomy-governance';
import { isUuid } from '@/lib/validation';
import { articleImages, requireSafeEditorialImages } from '@/lib/images/image-safety';

export const dynamic = 'force-dynamic';
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid draft is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { user } = auth;
  const supabase = getSupabaseAdminClient();
  const [{ data: story, error: storyError }, { count: sourceCount, error: sourcesError }] = await Promise.all([
    supabase.from('stories').select('id, status, published_at, image_url, image_alt, generation_metadata, taxonomy_review_required, taxonomy_review_reason').eq('id', id).single(),
    supabase.from('story_sources').select('*', { count: 'exact', head: true }).eq('story_id', id),
  ]);
  if (storyError || !story) return Response.json({ error: 'Draft not found.' }, { status: 404 });
  if (sourcesError) return Response.json({ error: 'Sources could not be verified.' }, { status: 500 });
  if (story.status !== 'draft') return Response.json({ error: 'Only a draft can be published.' }, { status: 409 });
  if (story.taxonomy_review_required) return Response.json({ error: story.taxonomy_review_reason || 'Choose a valid topic before publishing.' }, { status: 422 });
  const content = (story.generation_metadata as { article_content?: StoryDraftContent } | null)?.article_content;
  if (!content) return Response.json({ error: 'The article content could not be verified.' }, { status: 422 });
  const failed = publicationChecks(content, sourceCount ?? 0).filter((check) => !check.passed);
  if (failed.length) return Response.json({ error: `Complete these checks before publishing: ${failed.map((check) => check.label).join('; ')}.` }, { status: 422 });
  try {
    await requireSafeEditorialImages(articleImages(story, content));
  } catch {
    return Response.json({ error: 'The featured image could not pass the weapon-free image review. Choose another image or retry its review.' }, { status: 422 });
  }
  const publishedAt = story.published_at ?? new Date().toISOString();
  const { error: updateError } = await supabase.from('stories').update({ status: 'published', published_at: publishedAt, reviewer_id: user.id }).eq('id', id).eq('status', 'draft');
  if (updateError) return Response.json({ error: 'The article could not be published.' }, { status: 500 });
  await Promise.all([
    supabase.from('editorial_actions').insert({ story_id: id, user_id: user.id, action: 'published', notes: 'Article passed the publication checklist and was published.' }),
    supabase.from('publication_queue').update({ status: 'published', published_at: publishedAt, scheduled_for: publishedAt, claimed_at: null, hold_reason: null }).eq('story_id', id).in('status', ['queued', 'scheduled', 'publishing', 'held']),
  ]);
  try {
    await runTaxonomyGovernance({ includeTopics: true, maxEntities: 8 });
  } catch (error) {
    console.warn('Article published, but taxonomy governance could not be refreshed', error);
  }
  return Response.json({ saved: true, publishedAt });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid article is required.' }, { status: 400 });
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { user } = auth;
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from('stories').update({ status: 'draft', reviewer_id: user.id }).eq('id', id).eq('status', 'published');
  if (error) return Response.json({ error: 'The article could not be unpublished.' }, { status: 500 });
  await Promise.all([
    supabase.from('editorial_actions').insert({ story_id: id, user_id: user.id, action: 'edited', notes: 'Article unpublished for correction. Its original publication date was preserved.' }),
    supabase.from('publication_queue').update({ status: 'cancelled', scheduled_for: null, claimed_at: null, hold_reason: 'Article was manually unpublished.', editor_approved_at: null, editor_approved_by: null }).eq('story_id', id),
  ]);
  return Response.json({ saved: true });
}
