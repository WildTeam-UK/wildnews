import { cleanDraftContent, type StoryDraftContent } from '@/lib/openai/draft-story';
import { unexpectedErrorResponse } from '@/lib/api-errors';
import { recordUnsplashSelection } from '@/lib/images/unsplash';
import { requireApiAdmin } from '@/lib/supabase/require-api-admin';
import { queueReadyDrafts } from '@/lib/publication-queue';
import { normalizeEditorialTopics } from '@/lib/taxonomy';
import { articleLinkRows } from '@/lib/article-linking';
import { isUuid } from '@/lib/validation';
import { articleBodyText } from '@/lib/article-structure';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: 'A valid draft is required.' }, { status: 400 });

  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const { supabase, user } = auth;

  const { data: story, error: storyError } = await supabase.from('stories').select('id, status, generation_metadata').eq('id', id).single();
  if (storyError || !story) return Response.json({ error: 'Draft not found.' }, { status: 404 });
  if (story.status !== 'draft') return Response.json({ error: 'Only private drafts can be edited here.' }, { status: 409 });

  const body = await request.json().catch(() => null) as { content?: StoryDraftContent } | null;
  if (!body?.content) return Response.json({ error: 'Draft content is required.' }, { status: 400 });
  const metadata = (story.generation_metadata ?? {}) as Record<string, unknown> & { source_ids?: { id?: string }[] };
  const validSourceIds = new Set((metadata.source_ids ?? []).flatMap((source) => source.id ? [source.id] : []));

  try {
    const previousContent = metadata.article_content as Partial<StoryDraftContent> | undefined;
    const content = cleanDraftContent({ ...body.content, template_version: previousContent?.template_version === 3 ? 3 : 2, topics: normalizeEditorialTopics(body.content.topics ?? []) }, validSourceIds);
    const selectedNewUnsplashImage = content.image_credit?.provider === 'unsplash' && content.image_credit.source_id !== previousContent?.image_credit?.source_id;
    const taxonomyReady = content.topics.length > 0;
    const currentClassification = (metadata.topic_classification ?? {}) as Record<string, unknown>;
    const updatedMetadata = { ...metadata, article_content: content, topic_classification: { ...currentClassification, primary_topic: content.topics[0] ?? null, secondary_topics: content.topics.slice(1), confidence: taxonomyReady ? 100 : 0, review_required: !taxonomyReady, review_reason: taxonomyReady ? '' : 'Choose at least one controlled topic.' }, last_edited_at: new Date().toISOString() };
    const { data: storedTopics, error: storedTopicsError } = content.topics.length
      ? await supabase.from('topics').select('id, name').in('name', content.topics).eq('active', true)
      : { data: [], error: null };
    if (storedTopicsError) throw storedTopicsError;
    const primaryTopic = storedTopics?.find((topic) => topic.name === content.topics[0]);
    const { error: updateError } = await supabase.from('stories').update({
      headline: content.headline,
      standfirst: content.standfirst,
      overview: content.story_at_a_glance.map((item) => item.text).join('\n\n'),
      body: articleBodyText(content),
      key_takeaways: content.key_takeaways,
      why_it_matters: content.why_it_matters.text,
      agreed_points: content.what_we_know,
      disputed_points: content.what_we_dont_know,
      open_questions: content.what_we_dont_know.map((item) => item.text),
      image_url: content.image_url || null,
      image_alt: content.image_alt || null,
      reviewer_id: user.id,
      primary_topic_id: primaryTopic?.id ?? null,
      taxonomy_review_required: !taxonomyReady,
      taxonomy_review_reason: taxonomyReady ? null : 'Choose at least one controlled topic.',
      taxonomy_confidence: taxonomyReady ? 100 : 0,
      generation_metadata: updatedMetadata,
    }).eq('id', id);
    if (updateError) throw updateError;
    const { error: clearTopicsError } = await supabase.from('story_topics').delete().eq('story_id', id);
    if (clearTopicsError) throw clearTopicsError;
    if (storedTopics?.length) {
      const { error: linkTopicsError } = await supabase.from('story_topics').insert(storedTopics.map((topic) => ({ story_id: id, topic_id: topic.id })));
      if (linkTopicsError) throw linkTopicsError;
    }
    const contextualLinks = articleLinkRows(id, content);
    const { error: clearContextualLinksError } = await supabase.from('story_contextual_links').delete().eq('story_id', id);
    if (clearContextualLinksError) throw clearContextualLinksError;
    if (contextualLinks.length) {
      const { error: contextualLinksError } = await supabase.from('story_contextual_links').insert(contextualLinks);
      if (contextualLinksError) throw contextualLinksError;
    }
    if (selectedNewUnsplashImage) {
      try {
        await recordUnsplashSelection(content.image_credit?.download_location ?? '');
      } catch (error) {
        console.warn('Unsplash selection tracking failed after saving the draft', error);
      }
    }
    await supabase.from('editorial_actions').insert({ story_id: id, user_id: user.id, action: 'edited', notes: 'Draft edited and saved in the editorial workspace.' });
    try {
      const queue = await queueReadyDrafts(null, id, false, false, false, true);
      return Response.json({ saved: true, queue });
    } catch (queueError) {
      const queueWarning = queueError instanceof Error ? queueError.message : 'The publishing queue could not be refreshed.';
      return Response.json({ saved: true, queueWarning });
    }
  } catch (error) {
    return unexpectedErrorResponse('Draft save failed', error, 'The draft could not be saved.');
  }
}
