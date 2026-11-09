import type { ArticleTemplateData } from '@/components/article-template';
import { stripSourceMarkers } from '@/lib/article-text';
import { migrateDraftContent, type StoryDraftContent } from '@/lib/openai/draft-story';
import { digestPath, type DigestContent, type DigestSourceStory } from '@/lib/digests';
import type { Story } from '@/lib/stories';
import { getSupabasePublicClient } from '@/lib/supabase/public';
import { normalizeEditorialTopics } from '@/lib/taxonomy';
import type { TrainingCoursePromotion } from '@/lib/training-courses';
import { attachStoredArticleLinks, type ArticleLinkSection, type ArticleLinkType } from '@/lib/article-linking';
import { firstRelation } from '@/lib/supabase/relations';
import React from 'react';

const { cache } = React;

type PublishedSource = { id: string; source_name: string; source_title: string; source_url: string; source_role: string; display_order: number };
type PublishedTopicLink = { topics: { name: string; slug: string } | { name: string; slug: string }[] | null };
type PublishedTagLink = { confidence: number | null; content_tags: { name: string; slug: string; status: string } | { name: string; slug: string; status: string }[] | null };
type PublishedCourseRecommendation = { placement: string; confidence: number | null; rationale: string | null; training_courses: TrainingCoursePromotion | TrainingCoursePromotion[] | null };
type PublishedContextualLink = { link_type: ArticleLinkType; target_id: string; href: string; anchor_text: string; section_key: ArticleLinkSection; item_index: number; external: boolean; confidence: number; rationale: string | null };
type PublishedEditorialUpdate = { id: string; change_summary: string; applied_at: string; public_content_changed: boolean; public_source_ids: string[] };
export type PublishedConservationOutlook = { classification: 'positive' | 'mixed' | 'neutral' | 'negative'; score: number; confidence: number; rationale: string };

export type PublicTaxonomyArchive = { name: string; slug: string; description: string | null; seo_title: string | null; meta_description: string | null };

export type PublishedStory = {
  id: string;
  slug: string;
  headline: string;
  standfirst: string;
  image_url: string | null;
  image_alt: string | null;
  published_at: string;
  updated_at: string;
  editorial_updated_at: string | null;
  editorial_change_summary: string | null;
  content_type: 'news' | 'daily_digest' | 'weekly_digest';
  digest_period_end: string | null;
  generation_metadata: Record<string, unknown>;
  story_topics: PublishedTopicLink[];
  story_tags: PublishedTagLink[];
  story_conservation_outlooks: PublishedConservationOutlook | PublishedConservationOutlook[] | null;
};

type PublishedStoryDetail = PublishedStory & {
  story_sources: PublishedSource[];
  story_course_recommendations: PublishedCourseRecommendation[];
  story_contextual_links: PublishedContextualLink[];
  story_editorial_revisions: PublishedEditorialUpdate[];
};

const storyBaseSelect = 'id, slug, headline, standfirst, image_url, image_alt, published_at, updated_at, editorial_updated_at, editorial_change_summary, content_type, digest_period_end, story_topics(topics(name, slug)), story_tags(confidence, content_tags(name, slug, status)), story_conservation_outlooks(classification, score, confidence, rationale)';
const storyListingSelect = `${storyBaseSelect}, article_topics:generation_metadata->article_content->topics, digest_topics:generation_metadata->digest_content->topics, article_image:generation_metadata->article_content->>image_url, digest_sources:generation_metadata->digest_source_stories`;
const storyDetailSelect = `${storyBaseSelect}, generation_metadata, story_sources(id, source_name, source_title, source_url, source_role, display_order), story_course_recommendations(placement, confidence, rationale, training_courses(id, title, short_title, description, course_url, primary_colour, ad_headline, ad_description, cta_label)), story_contextual_links(link_type, target_id, href, anchor_text, section_key, item_index, external, confidence, rationale), story_editorial_revisions(id, change_summary, applied_at, public_content_changed, public_source_ids)`;

function listingRecords(rows: unknown[]): PublishedStory[] {
  return rows.map((value) => {
    const row = value as PublishedStory & { article_topics?: string[]; digest_topics?: string[]; article_image?: string; digest_sources?: DigestSourceStory[] };
    return { ...row, generation_metadata: { article_content: { topics: row.article_topics ?? [], image_url: row.article_image ?? '' }, digest_content: { topics: row.digest_topics ?? [] }, digest_source_stories: row.digest_sources ?? [] } };
  });
}

export function publishedTopics(story: PublishedStory) {
  const article = (story.generation_metadata.article_content ?? {}) as Partial<StoryDraftContent>;
  const digest = (story.generation_metadata.digest_content ?? {}) as Partial<DigestContent>;
  const linked = story.story_topics.flatMap((link) => firstRelation(link.topics)?.name ?? []);
  return normalizeEditorialTopics([...(article.topics ?? []), ...(digest.topics ?? []), ...linked].filter(Boolean));
}

export function publishedTags(story: PublishedStory) {
  return story.story_tags.flatMap((link) => {
    const tag = firstRelation(link.content_tags);
    return tag?.status === 'approved' ? [{ name: tag.name, slug: tag.slug, confidence: link.confidence ?? 0 }] : [];
  }).sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
}

export function publishedConservationOutlook(story: PublishedStory) {
  return firstRelation(story.story_conservation_outlooks);
}

export const getGoodNewsSettings = cache(async () => {
  const { data, error } = await getSupabasePublicClient().from('good_news_settings').select('minimum_score, minimum_confidence').eq('id', true).single();
  if (error) throw error;
  return data as { minimum_score: number; minimum_confidence: number };
});

export type GoodNewsSettings = Awaited<ReturnType<typeof getGoodNewsSettings>>;

export function isPublishedGoodNews(story: PublishedStory, settings?: GoodNewsSettings) {
  if (!settings || story.content_type !== 'news') return false;
  const outlook = publishedConservationOutlook(story);
  return outlook?.classification === 'positive' && outlook.score >= settings.minimum_score && outlook.confidence >= settings.minimum_confidence;
}

export const getPublicTopic = cache(async (slug: string): Promise<PublicTaxonomyArchive | null> => {
  const { data, error } = await getSupabasePublicClient().from('topics').select('name, slug, description, seo_title, meta_description').eq('slug', slug).eq('active', true).maybeSingle();
  if (error) throw error;
  return data as PublicTaxonomyArchive | null;
});

export const getPublicTag = cache(async (slug: string): Promise<PublicTaxonomyArchive | null> => {
  const { data, error } = await getSupabasePublicClient().from('content_tags').select('name, slug, description, seo_title, meta_description').eq('slug', slug).eq('status', 'approved').maybeSingle();
  if (error) throw error;
  return data as PublicTaxonomyArchive | null;
});

export const getPublishedStory = cache(async (slug: string): Promise<PublishedStoryDetail | null> => {
  const { data, error } = await getSupabasePublicClient().from('stories').select(storyDetailSelect).eq('slug', slug).eq('content_type', 'news').eq('status', 'published').lte('published_at', new Date().toISOString()).maybeSingle();
  if (error) throw error;
  return data as unknown as PublishedStoryDetail | null;
});

export const getPublishedStories = cache(async (limit = 100): Promise<PublishedStory[]> => {
  const { data, error } = await getSupabasePublicClient().from('stories').select(storyListingSelect).eq('status', 'published').lte('published_at', new Date().toISOString()).order('published_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return listingRecords(data ?? []);
});

export async function getPublishedStoriesForTopic(topic: string, limit = 12): Promise<PublishedStory[]> {
  const topicMatchSelect = `${storyListingSelect}, homepage_topic:story_topics!inner(topics!inner(name))`;
  const { data, error } = await getSupabasePublicClient().from('stories')
    .select(topicMatchSelect)
    .eq('status', 'published')
    .lte('published_at', new Date().toISOString())
    .eq('homepage_topic.topics.name', topic)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return listingRecords(data ?? []);
}

export async function getPopulatedPublicTopics(): Promise<string[]> {
  const { data, error } = await getSupabasePublicClient().from('topics')
    .select('name, story_topics!inner(stories!inner(id))')
    .eq('active', true)
    .eq('story_topics.stories.status', 'published')
    .lte('story_topics.stories.published_at', new Date().toISOString());
  if (error) throw error;
  return (data ?? []).map((topic) => topic.name);
}

export async function getAllPublishedStories(maximum = 50_000): Promise<PublishedStory[]> {
  const pageSize = 1000;
  const stories: PublishedStory[] = [];
  while (stories.length < maximum) {
    const batchSize = Math.min(pageSize, maximum - stories.length);
    const { data, error } = await getSupabasePublicClient().from('stories')
      .select(storyListingSelect)
      .eq('status', 'published')
      .lte('published_at', new Date().toISOString())
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(stories.length, stories.length + batchSize - 1);
    if (error) throw error;
    const batch = listingRecords(data ?? []);
    stories.push(...batch);
    if (batch.length < batchSize) break;
  }
  return stories;
}

export function relatedPublishedStories(referenceStories: PublishedStory[], candidates: PublishedStory[], limit = 6) {
  const excludedIds = new Set(referenceStories.map((story) => story.id));
  const referenceTopics = new Set(referenceStories.flatMap(publishedTopics));
  const referenceTags = new Set(referenceStories.flatMap((story) => publishedTags(story).map((tag) => tag.slug)));

  return candidates
    .filter((story) => !excludedIds.has(story.id))
    .map((story, index) => {
      const sharedTopics = publishedTopics(story).filter((topic) => referenceTopics.has(topic)).length;
      const sharedTags = publishedTags(story).filter((tag) => referenceTags.has(tag.slug)).length;
      return { story, index, score: (sharedTopics * 3) + (sharedTags * 2) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ story }) => story);
}

export function publishedStoryToArticle(story: PublishedStoryDetail, goodNewsSettings?: GoodNewsSettings): ArticleTemplateData {
  const content = attachStoredArticleLinks(migrateDraftContent(structuredClone(story.generation_metadata.article_content)), story.story_contextual_links.map((link) => ({ type: link.link_type, target_id: link.target_id, href: link.href, anchor_text: link.anchor_text, section_key: link.section_key, item_index: link.item_index, external: link.external, confidence: link.confidence, rationale: link.rationale ?? '' })));
  const sources = [...story.story_sources].sort((a, b) => a.display_order - b.display_order);
  const featuredRecommendation = story.story_course_recommendations?.find((recommendation) => recommendation.placement === 'featured');
  const coursePromotion = featuredRecommendation ? firstRelation(featuredRecommendation.training_courses) : null;
  const validSourceIds = new Set(sources.map((source) => `source-${source.display_order}`));
  const editorialUpdates = [...(story.story_editorial_revisions ?? [])]
    .filter((revision) => revision.applied_at && revision.change_summary)
    .sort((a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime())
    .map((revision) => ({ date: revision.applied_at, summary: revision.change_summary, sourceIds: [...new Set(revision.public_source_ids ?? [])].filter((sourceId) => validSourceIds.has(sourceId)), sourceOnly: !revision.public_content_changed }));
  return {
    templateVersion: content.template_version,
    topics: publishedTopics(story),
    discoveryTags: publishedTags(story).slice(0, 3),
    headline: story.headline,
    storyAtAGlance: content.story_at_a_glance.map((item) => ({ text: item.text, sourceIds: item.source_ids })),
    imageUrl: story.image_url ?? content.image_url,
    imageAlt: story.image_alt ?? content.image_alt,
    imageCredit: content.image_credit,
    publishedAt: story.published_at,
    editorialUpdates,
    updatedAt: story.editorial_updated_at ?? story.published_at,
    keyTakeaways: content.key_takeaways.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    whyItMatters: { text: content.why_it_matters.text, sourceIds: content.why_it_matters.source_ids, links: content.why_it_matters.links },
    whatHappensNext: { text: content.what_happens_next.text, sourceIds: content.what_happens_next.source_ids, links: content.what_happens_next.links },
    whatWeKnow: content.what_we_know.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    whatWeDontKnow: content.what_we_dont_know.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    sources: sources.map((source) => ({ id: `source-${source.display_order}`, recordId: source.id, name: source.source_name, title: source.source_title, url: source.source_url, primary: source.source_role === 'primary' })),
    coverage: content.coverage_analysis,
    coursePromotion,
    goodNews: isPublishedGoodNews(story, goodNewsSettings),
  };
}

export function publishedStoryToListing(story: PublishedStory, goodNewsSettings?: GoodNewsSettings): Story {
  const topics = publishedTopics(story);
  if (story.content_type !== 'news') {
    const sourceStories = (story.generation_metadata.digest_source_stories ?? []) as DigestSourceStory[];
    const type = story.content_type === 'weekly_digest' ? 'weekly' : 'daily';
    const date = story.slug.replace(`${type}-digest-`, '');
    return {
      slug: story.slug,
      href: digestPath(type, date),
      topic: topics[0] ?? 'Conservation Practice',
      topics,
      title: story.headline,
      summary: stripSourceMarkers(story.standfirst),
      image: story.image_url ?? sourceStories.find((source) => source.image_url)?.image_url ?? '',
      goodNews: false,
      digestType: type,
    };
  }
  const content = story.generation_metadata.article_content as StoryDraftContent;
  return {
    slug: story.slug,
    href: `/stories/${story.slug}`,
    topic: topics[0] ?? 'Conservation Practice',
    topics,
    title: story.headline,
    summary: stripSourceMarkers(story.standfirst),
    image: story.image_url ?? content.image_url,
    goodNews: isPublishedGoodNews(story, goodNewsSettings),
  };
}
