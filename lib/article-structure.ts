import type { StoryDraftContent } from '@/lib/openai/draft-story';

// New articles should retain a substantial core briefing without optional caveats.
export const MIN_ARTICLE_CORE_WORDS = 350;

export function articleCoreWordCount(content: StoryDraftContent): number {
  return [
    ...content.story_at_a_glance.map((item) => item.text),
    ...content.key_takeaways.map((item) => item.text),
    content.why_it_matters.text,
    content.what_happens_next.text,
  ].join(' ').match(/\S+/g)?.length ?? 0;
}

export function articleBodyText(content: StoryDraftContent): string {
  const concise = content.template_version === 3;
  return [
    `Why this matters\n${content.why_it_matters.text}`,
    `What happens next\n${content.what_happens_next.text}`,
    ...(!concise ? [`What we know\n${content.what_we_know.map((item) => item.text).join('\n')}`] : []),
    ...(!concise || content.what_we_dont_know.length ? [`${concise ? "What's still unclear" : "What we don't know"}\n${content.what_we_dont_know.map((item) => item.text).join('\n')}`] : []),
  ].join('\n\n');
}
