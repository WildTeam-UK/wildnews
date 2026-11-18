/* oxlint-disable next/no-html-link-for-pages -- full page loads avoid unreliable Vinext client navigation on dynamic archive routes */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EditorialArchiveCard } from '@/components/editorial-archive-card';
import { EditorialPageEnd } from '@/components/editorial-page-end';
import { ArchivePagination } from '@/components/archive-pagination';
import { archivePageNumber, archivePagePath } from '@/lib/archive-pagination';
import { ArchiveHero } from '@/components/archive-hero';
import { InteriorHeader } from '@/components/interior-header';
import { TopicTag } from '@/components/topic-tag';
import { StoryTags } from '@/components/story-tags';
import { getGoodNewsSettings, getPublishedStories, getPublishedArchive, publishedStoryToListing, relatedPublishedStories } from '@/lib/published-stories';
import { allTopics, cleanCopy, storyHref, storyImage, topicSlug } from '@/lib/stories';
import { InlineBrand } from '@/components/inline-brand';
import { pageMetadata, withSiteName } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return allTopics.map((topic) => ({ topic: topicSlug(topic) }));
}

type ArchiveProps = { params: Promise<{ topic: string }>; searchParams: Promise<{ page?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: ArchiveProps): Promise<Metadata> {
  const slug = (await params).topic;
  const page = archivePageNumber((await searchParams).page);
  const result = page === null ? null : await getPublishedArchive('topics', slug, page);
  if (!result) return { title: 'Topic not found | WILDNEWS', robots: { index: false, follow: false } };
  const { archive } = result;
  const baseTitle = archive.seo_title ?? `${archive.name} news | WILDNEWS`;
  const title = page === 1 ? baseTitle : withSiteName(`${withSiteName(baseTitle).replace(/ \| WILDNEWS$/, '')} | Page ${page}`);
  const description = archive.meta_description ?? archive.description ?? `The latest ${archive.name.toLowerCase()} reporting, analysis and ideas from WILDNEWS.`;
  return pageMetadata({ title, description, path: archivePagePath(`/topics/${slug}`, page!) });
}

export default async function TopicPage({ params, searchParams }: ArchiveProps) {
  const slug = (await params).topic;
  const page = archivePageNumber((await searchParams).page);
  if (page === null) notFound();
  const result = await getPublishedArchive('topics', slug, page);
  if (!result) notFound();
  const { archive, stories: records, total } = result;
  const [published, goodNewsSettings] = await Promise.all([getPublishedStories(200), getGoodNewsSettings()]);
  const topicStories = records.map((story) => publishedStoryToListing(story, goodNewsSettings));
  const related = relatedPublishedStories(records, published).map((story) => publishedStoryToListing(story, goodNewsSettings));
  const topic = archive.name;
  return <main className="archive-page">
    <InteriorHeader />
    <ArchiveHero
      label={<TopicTag topic={topic} />}
      title={topic}
      description={<InlineBrand text={archive.description ?? `The latest reporting, analysis and practical ideas shaping ${topic.toLowerCase()} conservation.`} />}
      meta={`${total} ${total === 1 ? 'story' : 'stories'}`}
    />
    <section className="topic-page-grid shell">
      {topicStories.map((story, index) => <EditorialArchiveCard
        featured={index === 0}
        href={storyHref(story)}
        image={storyImage(story)}
        goodNews={story.goodNews}
        digestType={story.digestType}
        labels={<StoryTags story={story} />}
        title={cleanCopy(story.title)}
        summary={cleanCopy(story.summary)}
        key={story.slug}
      />)}
    </section>
    <ArchivePagination path={`/topics/${slug}`} page={page} total={total} />
    <EditorialPageEnd newsletterId={`topic-${slug}-digest-email`} stories={related} />
  </main>;
}
