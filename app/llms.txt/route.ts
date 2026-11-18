import { digestPath } from '@/lib/digests';
import { getAllPublishedStories, getPublishedStories, publicTagArchiveSlugs, publishedTags, publishedTopics } from '@/lib/published-stories';
import { absoluteUrl } from '@/lib/seo';
import { topicSlug } from '@/lib/stories';

export const dynamic = 'force-dynamic';

function singleLine(value: string) {
  return value
    .replace(/\[source-[^\]]+\]/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function linkLabel(value: string) {
  return singleLine(value).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function storyPath(story: Awaited<ReturnType<typeof getPublishedStories>>[number]) {
  if (story.content_type === 'news') return `/stories/${story.slug}`;
  const type = story.content_type === 'weekly_digest' ? 'weekly' : 'daily';
  return digestPath(type, story.slug.replace(`${type}-digest-`, ''));
}

export async function GET() {
  const stories = await getAllPublishedStories();
  const news = stories.filter((story) => story.content_type === 'news').slice(0, 20);
  const digests = stories.filter((story) => story.content_type !== 'news').slice(0, 10);
  const topics = [...new Set(stories.flatMap(publishedTopics))].sort((a, b) => a.localeCompare(b));
  const eligibleTags = publicTagArchiveSlugs(stories);
  const tags = [...new Map(stories.flatMap(publishedTags).filter((tag) => eligibleTags.has(tag.slug)).map((tag) => [tag.slug, tag])).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);

  const lines = [
    '# WILDNEWS',
    '',
    '> Source-led conservation news briefings from WildTeam, bringing together reporting, evidence and context from across a fragmented field.',
    '',
    'WILDNEWS uses AI to find, group and summarise conservation coverage. Its briefings are not original reporting, and every briefing links readers to its source material. Canonical public URLs use https://news.wildteam.org.uk.',
    '',
    '## Key pages',
    '',
    `- [Latest conservation news](${absoluteUrl('/')}): The latest published WILDNEWS briefings and conservation coverage.`,
    `- [WILDNEWS digests](${absoluteUrl('/digests')}): Daily and weekly editorial roundups of published conservation news.`,
    `- [Good news in conservation](${absoluteUrl('/good-news-in-conservation')}): Conservation stories that meet the site's positive-outlook criteria.`,
    `- [How WILDNEWS uses AI](${absoluteUrl('/how-we-use-ai')}): The editorial process, safeguards and limitations.`,
    `- [How good news is classified](${absoluteUrl('/how-we-classify-good-news')}): The criteria used to identify positive conservation developments.`,
    `- [About WILDNEWS](${absoluteUrl('/about')}): Information about WILDNEWS and WildTeam.`,
  ];

  if (news.length) {
    lines.push('', '## Latest stories', '');
    for (const story of news) {
      lines.push(`- [${linkLabel(story.headline)}](${absoluteUrl(storyPath(story))}): ${singleLine(story.standfirst)}`);
    }
  }

  if (digests.length) {
    lines.push('', '## Latest digests', '');
    for (const story of digests) {
      lines.push(`- [${linkLabel(story.headline)}](${absoluteUrl(storyPath(story))}): ${singleLine(story.standfirst)}`);
    }
  }

  if (topics.length) {
    lines.push('', '## Topic archives', '');
    for (const topic of topics) {
      lines.push(`- [${linkLabel(topic)}](${absoluteUrl(`/topics/${topicSlug(topic)}`)}): Published WILDNEWS coverage filed under ${singleLine(topic)}.`);
    }
  }

  if (tags.length) {
    lines.push('', '## Discovery tag archives', '');
    for (const tag of tags) {
      lines.push(`- [${linkLabel(tag.name)}](${absoluteUrl(`/tags/${tag.slug}`)}): Published WILDNEWS coverage tagged ${singleLine(tag.name)}.`);
    }
  }

  return new Response(`${lines.join('\n')}\n`, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
