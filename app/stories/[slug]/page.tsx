/* oxlint-disable next/no-html-link-for-pages -- full page loads avoid unreliable Vinext client navigation on dynamic story routes */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArticleTemplate } from '@/components/article-template';
import { EditorialPageEnd } from '@/components/editorial-page-end';
import { InteriorHeader } from '@/components/interior-header';
import { JsonLd } from '@/components/json-ld';
import { getGoodNewsSettings, getPublishedStories, getPublishedStory, publishedStoryToArticle, publishedStoryToListing, publishedTopics, relatedPublishedStories } from '@/lib/published-stories';
import { articleMetadata, newsArticleJsonLd, withSiteName } from '@/lib/seo';
import { operationalLog } from '@/lib/operational-log';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const slug = (await params).slug;
  const published = await getPublishedStory(slug);
  if (!published) return { title: 'Story not found | WILDNEWS', robots: { index: false, follow: false } };

  const content = published.generation_metadata.article_content as { seo_title?: string; seo_description?: string; image_url?: string; image_alt?: string } | undefined;
  const title = content?.seo_title || published.headline;
  const description = content?.seo_description || published.standfirst;
  return articleMetadata({ title: withSiteName(title), description, path: `/stories/${published.slug}`, image: published.image_url ?? content?.image_url, imageAlt: published.image_alt ?? content?.image_alt, publishedTime: published.published_at, modifiedTime: published.editorial_updated_at ?? published.published_at });
}

export default async function StoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const slug = (await params).slug;
  const published = await getPublishedStory(slug);
  if (!published) notFound();

  const [relatedResult, settingsResult] = await Promise.allSettled([getPublishedStories(20), getGoodNewsSettings()]);
  const allPublished = relatedResult.status === 'fulfilled' ? relatedResult.value : [];
  const goodNewsSettings = settingsResult.status === 'fulfilled' ? settingsResult.value : undefined;
  const degraded = relatedResult.status === 'rejected' || settingsResult.status === 'rejected';
  for (const result of [relatedResult, settingsResult]) if (result.status === 'rejected') operationalLog('error', { operation: 'story_optional_section' }, result.reason);
  const related = relatedPublishedStories([published], allPublished).map((story) => publishedStoryToListing(story, goodNewsSettings));
  const article = publishedStoryToArticle(published, goodNewsSettings);
  const structuredData = newsArticleJsonLd({ headline: published.headline, description: published.standfirst, path: `/stories/${published.slug}`, image: article.imageUrl, publishedTime: published.published_at, modifiedTime: published.editorial_updated_at ?? published.published_at, sections: publishedTopics(published) });

  return <main data-public-page-degraded={degraded ? true : undefined}>
    <InteriorHeader />
    <JsonLd data={structuredData} />
    <ArticleTemplate article={article} storyId={published.id} sharePath={`/stories/${published.slug}`} />
    <EditorialPageEnd newsletterId="article-digest-email" stories={related} description="Keep exploring this topic." />
  </main>;
}
