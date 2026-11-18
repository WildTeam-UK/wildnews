/* oxlint-disable next/no-html-link-for-pages -- full page loads avoid unreliable Vinext client navigation on dynamic archive routes */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EditorialArchiveCard } from '@/components/editorial-archive-card';
import { EditorialPageEnd } from '@/components/editorial-page-end';
import { ArchivePagination } from '@/components/archive-pagination';
import { archivePageNumber, archivePagePath } from '@/lib/archive-pagination';
import { ArchiveHero } from '@/components/archive-hero';
import { InteriorHeader } from '@/components/interior-header';
import { StoryTags } from '@/components/story-tags';
import { getGoodNewsSettings, getPublishedStories, getPublishedArchive, publishedStoryToListing, relatedPublishedStories } from '@/lib/published-stories';
import { cleanCopy, storyHref, storyImage } from '@/lib/stories';
import { InlineBrand } from '@/components/inline-brand';
import { pageMetadata, withSiteName } from '@/lib/seo';

export const dynamic = 'force-dynamic';

type ArchiveProps = { params: Promise<{ tag: string }>; searchParams: Promise<{ page?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: ArchiveProps): Promise<Metadata> {
  const slug = (await params).tag;
  const page = archivePageNumber((await searchParams).page);
  const result = page === null ? null : await getPublishedArchive('tags', slug, page);
  if (!result) return { title: 'Tag not found | WILDNEWS', robots: { index: false, follow: false } };
  const { archive: tag } = result;
  const baseTitle = tag.seo_title ?? `${tag.name} conservation news | WILDNEWS`;
  const title = page === 1 ? baseTitle : withSiteName(`${withSiteName(baseTitle).replace(/ \| WILDNEWS$/, '')} | Page ${page}`);
  const description = tag.meta_description ?? tag.description ?? `Explore WILDNEWS briefings and source-led conservation coverage about ${tag.name}.`;
  return pageMetadata({ title, description, path: archivePagePath(`/tags/${slug}`, page!) });
}

export default async function TagPage({ params, searchParams }: ArchiveProps) {
  const slug = (await params).tag;
  const page = archivePageNumber((await searchParams).page);
  if (page === null) notFound();
  const result = await getPublishedArchive('tags', slug, page);
  if (!result) notFound();
  const { archive: tag, stories: records, total } = result;
  const [published, goodNewsSettings] = await Promise.all([getPublishedStories(200), getGoodNewsSettings()]);
  const stories = records.map((story) => publishedStoryToListing(story, goodNewsSettings));
  const related = relatedPublishedStories(records, published).map((story) => publishedStoryToListing(story, goodNewsSettings));
  return <main className="archive-page">
    <InteriorHeader />
    <ArchiveHero
      label={<a className="archive-tag-pill" href={`/tags/${tag.slug}`}>{tag.name}</a>}
      title={tag.name}
      description={<InlineBrand text={tag.description ?? `Source-led conservation briefings connected to ${tag.name}.`} />}
      meta={`${total} ${total === 1 ? 'story' : 'stories'}`}
    />
    <section className="topic-page-grid shell">{stories.map((story, index) => <EditorialArchiveCard
      featured={index === 0}
      href={storyHref(story)}
      image={storyImage(story)}
      goodNews={story.goodNews}
      digestType={story.digestType}
      labels={<StoryTags story={story} />}
      title={cleanCopy(story.title)}
      summary={cleanCopy(story.summary)}
      key={story.slug}
    />)}</section>
    <ArchivePagination path={`/tags/${slug}`} page={page} total={total} />
    <EditorialPageEnd newsletterId={`tag-${slug}-digest-email`} stories={related} />
  </main>;
}
