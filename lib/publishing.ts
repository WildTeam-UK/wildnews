import type { StoryDraftContent } from '@/lib/openai/draft-story';
import { EDITORIAL_TOPICS } from '@/lib/taxonomy';
import { articleCoreWordCount, MIN_ARTICLE_CORE_WORDS } from '@/lib/article-structure';

export type PublicationCheck = { key: string; label: string; passed: boolean };

export function publicationChecks(content: StoryDraftContent, sourceCount: number): PublicationCheck[] {
  const scores = Object.values(content.coverage_analysis ?? {});
  return [
    { key: 'taxonomy', label: 'A valid primary topic is assigned', passed: content.topics?.length >= 1 && content.topics.length <= 3 && content.topics.every((topic) => (EDITORIAL_TOPICS as readonly string[]).includes(topic)) },
    { key: 'identity', label: 'Headline and standfirst are complete', passed: Boolean(content.headline?.trim() && content.standfirst?.trim()) },
    { key: 'copy', label: 'Every required article section is complete', passed: content.story_at_a_glance?.length >= 2 && content.key_takeaways?.length === 5 && Boolean(content.why_it_matters?.text && content.what_happens_next?.text) && (content.template_version === 3 ? articleCoreWordCount(content) >= MIN_ARTICLE_CORE_WORDS : Boolean(content.what_we_know?.length && content.what_we_dont_know?.length)) },
    { key: 'sources', label: 'The article has linked sources', passed: sourceCount > 0 },
    { key: 'image', label: 'Featured image, alternative text and attribution are present', passed: Boolean(content.image_url && content.image_alt && content.image_credit?.creator_name && content.image_credit?.source_name) },
    { key: 'coverage', label: 'Coverage analysis contains valid scores', passed: scores.length === 3 && scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 100) },
    { key: 'seo', label: 'SEO title and description are complete', passed: Boolean(content.seo_title?.trim() && content.seo_description?.trim()) },
  ];
}
