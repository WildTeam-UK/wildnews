import type { MetadataRoute } from 'next';
import { digestPath } from '@/lib/digests';
import { getAllPublishedStories, publicTagArchiveSlugs, publishedTopics } from '@/lib/published-stories';
import { absoluteUrl } from '@/lib/seo';
import { topicSlug } from '@/lib/stories';

const staticPages: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }> = [
  { path: '/', priority: 1, changeFrequency: 'daily' },
  { path: '/digests', priority: 0.9, changeFrequency: 'daily' },
  { path: '/good-news-in-conservation', priority: 0.9, changeFrequency: 'daily' },
  { path: '/how-we-use-ai', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/how-we-classify-good-news', priority: 0.6, changeFrequency: 'monthly' },
  { path: '/how-coverage-analysis-works', priority: 0.5, changeFrequency: 'monthly' },
  { path: '/about', priority: 0.5, changeFrequency: 'monthly' },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const stories = await getAllPublishedStories();
  const latestUpdate = stories.reduce((latest, story) => Math.max(latest, Date.parse(story.updated_at)), 0);
  const archiveLastModified = latestUpdate ? new Date(latestUpdate) : new Date();
  const topicSlugs = new Set(stories.flatMap((story) => publishedTopics(story).map(topicSlug)));
  const tagSlugs = publicTagArchiveSlugs(stories);
  const staticEntries = staticPages.map(({ path, ...entry }) => ({ url: absoluteUrl(path), lastModified: archiveLastModified, ...entry }));
  const storyEntries = stories.map((story) => {
    const type = story.content_type === 'weekly_digest' ? 'weekly' : story.content_type === 'daily_digest' ? 'daily' : null;
    const date = type ? story.slug.replace(`${type}-digest-`, '') : null;
    return {
      url: absoluteUrl(type && date ? digestPath(type, date) : `/stories/${story.slug}`),
      lastModified: new Date(story.editorial_updated_at || story.published_at),
      changeFrequency: 'weekly' as const,
      priority: type ? 0.8 : 0.7,
    };
  });
  const topicEntries = [...topicSlugs].map((slug) => ({ url: absoluteUrl(`/topics/${slug}`), lastModified: archiveLastModified, changeFrequency: 'daily' as const, priority: 0.7 }));
  const tagEntries = [...tagSlugs].map((slug) => ({ url: absoluteUrl(`/tags/${slug}`), lastModified: archiveLastModified, changeFrequency: 'weekly' as const, priority: 0.5 }));
  return [...staticEntries, ...storyEntries, ...topicEntries, ...tagEntries];
}
