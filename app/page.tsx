/* oxlint-disable next/no-html-link-for-pages -- full page links keep Vinext navigation reliable */
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';
import { AllTopicsNav } from '@/components/all-topics-nav';
import { EditorialImage } from '@/components/editorial-image';
import { NewsletterCta } from '@/components/newsletter-cta';
import { SiteFooter } from '@/components/site-footer';
import { SiteNavigation } from '@/components/site-navigation';
import { StoryTags } from '@/components/story-tags';
import { TopicStoryShelf } from '@/components/topic-story-shelf';
import { TrainingBanner } from '@/components/training-banner';
import { getGoodNewsSettings, getPublishedStories, getPublishedStoriesForTopic, publishedStoryToListing } from '@/lib/published-stories';
import { cleanCopy, storyHref, storyImage, storyReadLabel } from '@/lib/stories';
import { EDITORIAL_TOPICS } from '@/lib/taxonomy';
import { DEFAULT_DESCRIPTION, DEFAULT_TITLE, pageMetadata } from '@/lib/seo';
import { GoodNewsBadge } from '@/components/good-news-badge';

const shelfTopics = [...EDITORIAL_TOPICS];

export const dynamic = 'force-dynamic';
export const metadata: Metadata = pageMetadata({ title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, path: '/' });

export default async function Home() {
  const [publishedRecords, goodNewsSettings, topicRecords] = await Promise.all([
    getPublishedStories(17),
    getGoodNewsSettings(),
    Promise.all(shelfTopics.map(async (topic) => [topic, await getPublishedStoriesForTopic(topic, 12)] as const)),
  ]);
  const published = publishedRecords.map((story) => publishedStoryToListing(story, goodNewsSettings));
  const liveStories = published;
  const [lead, ...moreStories] = liveStories;
  const primaryLatest = moreStories.slice(0, 6);
  const compactLatest = moreStories.slice(6, 16);
  const topicShelves = topicRecords.map(([topic, stories]) => ({ topic, stories: stories.map((story) => publishedStoryToListing(story, goodNewsSettings)) }));

  return <main>
    <header className="site-header">
      <SiteNavigation />
    </header>
    <AllTopicsNav />

    <section className="hero shell" aria-labelledby="lead-story">
      <div className="hero-grid">
        <div className="hero-copy">
          <div className="hero-meta"><StoryTags story={lead} /></div>
          <h1 id="lead-story"><a href={storyHref(lead)}>{cleanCopy(lead.title)}</a></h1>
          <p className="standfirst">{cleanCopy(lead.summary)}</p>
          <a className="read-more-button" href={storyHref(lead)}>Read story <ArrowRight /></a>
        </div>
        <a href={storyHref(lead)} className="hero-image" aria-label={`Read: ${cleanCopy(lead.title)}`}><EditorialImage src={storyImage(lead)} alt="" loading="eager" fetchPriority="high" decoding="async" />{lead.goodNews ? <GoodNewsBadge overlay /> : null}</a>
      </div>
    </section>

    <section className="latest shell" id="latest" aria-labelledby="latest-heading">
      <div className="section-heading"><h2 id="latest-heading">Latest stories</h2><p>Reporting, analysis and ideas from the people protecting nature.</p></div>
      <div className="latest-columns">
        <div className="latest-primary">{primaryLatest.map((story) => <article className="story-card" key={story.slug}><a href={storyHref(story)} className="story-image" aria-label={`Read: ${cleanCopy(story.title)}`}><EditorialImage src={storyImage(story)} alt="" loading="lazy" decoding="async" />{story.goodNews ? <GoodNewsBadge overlay /> : null}</a><div className="story-copy"><StoryTags story={story} /><h3><a href={storyHref(story)}>{cleanCopy(story.title)}</a></h3><p>{cleanCopy(story.summary)}</p><a className="text-link" href={storyHref(story)}>{storyReadLabel(story.digestType)} <ArrowRight /></a></div></article>)}</div>
        <aside className="latest-compact" aria-label="More latest stories">{compactLatest.map((story) => <article className="compact-story" key={story.slug}>
          <a className="compact-story-image" href={storyHref(story)} aria-label={`Read: ${cleanCopy(story.title)}`}><EditorialImage src={storyImage(story)} alt="" loading="lazy" decoding="async" />{story.goodNews ? <GoodNewsBadge overlay /> : null}</a>
          <div><StoryTags story={story} /><h3><a href={storyHref(story)}>{cleanCopy(story.title)}</a></h3></div>
        </article>)}</aside>
      </div>
    </section>

    <NewsletterCta id="homepage-digest-email" className="homepage-inline-newsletter shell" variant="streamlined" />

    <section className="topic-shelves" aria-label="Stories by topic">
      {topicShelves.map(({ topic, stories }) => <TopicStoryShelf topic={topic} stories={stories} key={topic} />)}
    </section>
    <TrainingBanner className="shell" />
    <NewsletterCta id="homepage-footer-digest-email" className="homepage-newsletter-cta shell" />
    <SiteFooter />
  </main>;
}
