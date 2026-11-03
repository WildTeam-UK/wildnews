import { hydrateDigestSourceStories, type DigestContent, type DigestSourceStory } from '@/lib/digests';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { firstRelation } from '@/lib/supabase/relations';
import { EDITORIAL_TOPICS, normalizeEditorialTopics } from '@/lib/taxonomy';
import { isCalendarDate } from '@/lib/validation';
import { londonCalendarDateFormatter } from '@/lib/date-format';
import { londonLocalDateTimeToUtc } from '@/lib/london-time';
import { prepareDigestDistributions } from '@/lib/digest-distribution';
import { invalidatePublicPages } from '@/lib/invalidate-public-pages';

function londonPublicationTime(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(londonLocalDateTimeToUtc(year, month, day, 9));
}

export async function publishDigest(storyId: string, { reviewerId, publicationDate, automated = false }: { reviewerId: string | null; publicationDate?: string; automated?: boolean }) {
  const supabase = getSupabaseAdminClient();
  const { data: story, error: storyError } = await supabase.from('stories')
    .select('id, slug, status, content_type, published_at, image_url, image_alt, generation_metadata')
    .eq('id', storyId)
    .in('content_type', ['daily_digest', 'weekly_digest'])
    .maybeSingle();
  if (storyError || !story) throw storyError ?? new Error('Digest not found.');

  const { data: run } = await supabase.from('digest_runs').select('id').eq('story_id', storyId).neq('status', 'skipped').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const type = story.content_type === 'weekly_digest' ? 'weekly' : 'daily';
  const editionDate = story.slug.replace(`${type}-digest-`, '');
  if (story.status === 'published') {
    if (run) await supabase.from('digest_runs').update({ status: 'published', completed_at: story.published_at ?? new Date().toISOString() }).eq('id', run.id);
    return { saved: true, alreadyPublished: true, publishedAt: story.published_at, publicPath: `/${type}-digest/${editionDate}` };
  }
  if (story.status !== 'draft') throw new Error('Only a private digest draft can be published.');
  if (publicationDate && (!isCalendarDate(publicationDate) || publicationDate !== editionDate || publicationDate >= londonCalendarDateFormatter.format(new Date()))) {
    throw new Error('A historical digest can only use its own earlier edition date.');
  }

  const metadata = (story.generation_metadata ?? {}) as Record<string, unknown> & { digest_content?: DigestContent };
  const content = metadata.digest_content;
  if (!content) throw new Error('The digest content could not be verified.');

  let topicNames: string[] = normalizeEditorialTopics(content.topics ?? []).slice(0, 3);
  if (!topicNames.length && run) {
    const { data: sourceLinks } = await supabase.from('digest_run_stories').select('stories(story_topics(topics(name)))').eq('run_id', run.id);
    const counts = new Map<string, number>();
    for (const link of (sourceLinks ?? []) as unknown as Array<{ stories: { story_topics?: Array<{ topics: { name: string } | { name: string }[] | null }> } | { story_topics?: Array<{ topics: { name: string } | { name: string }[] | null }> }[] | null }>) {
      const source = firstRelation(link.stories);
      for (const topicLink of source?.story_topics ?? []) {
        const names = Array.isArray(topicLink.topics) ? topicLink.topics.map((topic) => topic.name) : topicLink.topics?.name ? [topicLink.topics.name] : [];
        for (const name of normalizeEditorialTopics(names)) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    topicNames = [...counts].sort((a, b) => b[1] - a[1] || EDITORIAL_TOPICS.indexOf(a[0] as typeof EDITORIAL_TOPICS[number]) - EDITORIAL_TOPICS.indexOf(b[0] as typeof EDITORIAL_TOPICS[number])).slice(0, 3).map(([name]) => name);
  }
  if (!topicNames.length) topicNames = ['Conservation Practice'];
  content.topics = topicNames;

  const hydratedSources = await hydrateDigestSourceStories((metadata.digest_source_stories ?? []) as DigestSourceStory[]);
  const fallbackSourceImage = hydratedSources.find((source) => source.image_url === story.image_url) ?? hydratedSources.find((source) => source.image_url);
  const { data: topicRows, error: topicError } = await supabase.from('topics').select('id, name').in('name', topicNames).eq('active', true);
  if (topicError || !topicRows?.length) throw topicError ?? new Error('The digest topics could not be prepared.');
  const byName = new Map(topicRows.map((topic) => [topic.name, topic]));
  const selectedTopics = topicNames.flatMap((name) => byName.get(name) ?? []);

  const { error: clearTopicsError } = await supabase.from('story_topics').delete().eq('story_id', storyId);
  if (clearTopicsError) throw clearTopicsError;
  const { error: linkTopicsError } = await supabase.from('story_topics').insert(selectedTopics.map((topic) => ({ story_id: storyId, topic_id: topic.id })));
  if (linkTopicsError) throw linkTopicsError;

  const actionAt = new Date().toISOString();
  const publishedAt = publicationDate ? londonPublicationTime(publicationDate).toISOString() : actionAt;
  const publicationImageUrl = story.image_url ?? fallbackSourceImage?.image_url ?? null;
  const publicationImageAlt = story.image_alt ?? fallbackSourceImage?.image_alt ?? null;
  const { data: updated, error: updateError } = await supabase.from('stories')
    .update({ status: 'published', published_at: publishedAt, reviewer_id: reviewerId, primary_topic_id: selectedTopics[0].id, image_url: publicationImageUrl, image_alt: publicationImageAlt, generation_metadata: { ...metadata, digest_content: content, digest_source_stories: hydratedSources } })
    .eq('id', storyId)
    .eq('status', 'draft')
    .select('id')
    .maybeSingle();
  if (updateError || !updated) throw updateError ?? new Error('The digest could not be published.');
  await invalidatePublicPages();

  await supabase.from('editorial_actions').insert({ story_id: storyId, user_id: reviewerId, action: 'published', notes: automated ? 'Digest generated and published automatically.' : 'Digest reviewed and published manually.' });
  let distribution: Awaited<ReturnType<typeof prepareDigestDistributions>> | null = null;
  if (run) {
    await Promise.all([
      supabase.from('digest_runs').update({ status: 'published', completed_at: actionAt }).eq('id', run.id),
      supabase.from('digest_run_events').insert({ run_id: run.id, stage: 'publishing', message: automated ? 'Digest published automatically.' : publicationDate ? `Digest published manually with a historical publication time of 09:00 Europe/London on ${publicationDate}.` : 'Digest published manually.', details: { published_at: publishedAt } }),
    ]);
    if (publicationDate) {
      await supabase.from('digest_run_events').insert({ run_id: run.id, stage: 'distribution', message: 'External distribution skipped for a recovered historical edition.' });
    } else {
      try {
        distribution = await prepareDigestDistributions(run.id, storyId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Digest distribution could not be prepared.';
        await Promise.all([
          supabase.from('digest_runs').update({ status: 'partial', error_summary: detail.slice(0, 1000) }).eq('id', run.id),
          supabase.from('digest_run_events').insert({ run_id: run.id, stage: 'distribution', level: 'error', message: detail.slice(0, 1000) }),
        ]);
      }
    }
  }

  return { saved: true, alreadyPublished: false, publishedAt, publicPath: `/${type}-digest/${editionDate}`, distribution };
}
