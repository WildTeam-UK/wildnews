import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArticleTemplate, type ArticleTemplateData } from '@/components/article-template';
import { cleanDraftContent, migrateDraftContent, type StoryDraftContent } from '@/lib/openai/draft-story';
import { articleBodyText, articleCoreWordCount } from '@/lib/article-structure';
import { publicationChecks } from '@/lib/publishing';
import { generateEditorialRevision, revisionChangesPublicContent } from '@/lib/openai/generate-editorial-revision';
import { getOpenAIClient } from '@/lib/openai/client';

function fixture(version: 2 | 3, coreWords = 360): StoryDraftContent {
  const sourced = (words: number) => ({ text: Array.from({ length: words }, (_, index) => `evidence${index}`).join(' '), source_ids: ['source-1'] });
  return {
    template_version: version,
    topics: ['Forests'],
    headline: 'New mapping documents forest recovery',
    standfirst: 'A source-backed briefing about the findings and their limits.',
    story_at_a_glance: [sourced(coreWords - 310), sourced(50)],
    key_takeaways: Array.from({ length: 5 }, () => sourced(40)),
    why_it_matters: sourced(30),
    what_happens_next: sourced(30),
    what_we_know: version === 2 ? [sourced(10)] : [],
    what_we_dont_know: version === 2 ? [sourced(10)] : [],
    coverage_analysis: { ecological: 70, evidence: 80, consensus: 70 },
    image_url: 'https://example.org/forest.jpg',
    image_alt: 'Forest canopy',
    image_search_query: 'forest canopy',
    image_search_fallbacks: [],
    image_credit: { provider: 'manual', source_id: '', creator_name: 'Test creator', creator_url: '', source_name: 'Test source', source_url: '', licence_name: 'Permission', licence_url: '', illustrative: true, download_location: '' },
    seo_title: 'New mapping documents forest recovery',
    seo_description: 'What the mapping shows and why it matters.',
  };
}

function rendered(content: StoryDraftContent): string {
  const article: ArticleTemplateData = {
    templateVersion: content.template_version,
    topics: content.topics,
    headline: content.headline,
    storyAtAGlance: content.story_at_a_glance.map((item) => item.text),
    updatedAt: '2026-11-09',
    keyTakeaways: content.key_takeaways.map((item) => item.text),
    whyItMatters: content.why_it_matters.text,
    whatHappensNext: content.what_happens_next.text,
    whatWeKnow: content.what_we_know.map((item) => item.text),
    whatWeDontKnow: content.what_we_dont_know.map((item) => item.text),
    coverage: content.coverage_analysis,
    sources: [],
  };
  return renderToStaticMarkup(createElement(ArticleTemplate, { article }));
}

void test('existing and scheduled version 2 copy retains its sections and publication eligibility', () => {
  const existing = fixture(2, 330);
  const cleaned = cleanDraftContent(existing, new Set(['source-1']));
  assert.deepEqual(migrateDraftContent(existing), existing);
  assert.deepEqual(cleaned, existing);
  assert.equal(publicationChecks(cleaned, 3).every((check) => check.passed), true);
  assert.match(rendered(cleaned), /<h2>What we know<\/h2>/);
  assert.match(rendered(cleaned), /<h2>What we don&#x27;t know<\/h2>/);
});

void test('new articles save, publish and render without either optional evidence section', () => {
  const content = cleanDraftContent(fixture(3), new Set(['source-1']));
  assert.equal(migrateDraftContent(content).template_version, 3);
  assert.equal(publicationChecks(content, 3).every((check) => check.passed), true);
  assert.doesNotMatch(rendered(content), /<h2>What we know|<h2>What we don|<h2>What&#x27;s still unclear/);
  assert.doesNotMatch(articleBodyText(content), /What we know|What we don't know|What's still unclear/);
  assert.match(rendered(content), /<h2>What happens next<\/h2>/);
  assert.match(rendered(content), /<h2>Read the reporting<\/h2>/);
});

void test('a sourced uncertainty appears under the new label and survives a revision', () => {
  const original = fixture(3);
  const revised = cleanDraftContent({ ...original, what_we_dont_know: [{ text: 'Long-term outcomes remain unclear.', source_ids: ['source-1'] }] }, new Set(['source-1']));
  assert.match(rendered(revised), /<h2>What&#x27;s still unclear<\/h2>/);
  assert.match(articleBodyText(revised), /What's still unclear\nLong-term outcomes remain unclear\./);
  assert.equal(revisionChangesPublicContent(original, revised), true);
  assert.equal(revised.template_version, 3);
});

void test('optional caveats and listing copy cannot make a thin new article pass', () => {
  const thin = fixture(3, 349);
  thin.standfirst = 'Extra listing text '.repeat(20);
  thin.what_we_dont_know = [{ text: 'Extra uncertainty '.repeat(100), source_ids: ['source-1'] }];
  assert.equal(articleCoreWordCount(thin), 349);
  assert.throws(() => cleanDraftContent(thin, new Set(['source-1'])), /at least 350 words/);
  assert.equal(publicationChecks(thin, 3).find((check) => check.key === 'copy')?.passed, false);
  assert.doesNotThrow(() => cleanDraftContent(fixture(3, 350), new Set(['source-1'])));
});

void test('a new template does not restore removed known points or publish unsourced core claims', () => {
  const content = fixture(3);
  content.what_we_know = [{ text: 'Repeated detail.', source_ids: ['source-1'] }];
  assert.deepEqual(cleanDraftContent(content, new Set(['source-1'])).what_we_know, []);
  content.key_takeaways[0].source_ids = ['unknown-source'];
  assert.throws(() => cleanDraftContent(content, new Set(['source-1'])), /incomplete or insufficiently sourced/);
});

void test('the coverage editor preserves each template and allows source-only updates', async (context) => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-no-network';
  try {
    for (const version of [2, 3] as const) {
      const content = fixture(version);
      const create = context.mock.method(getOpenAIClient().responses, 'create', async (request: unknown) => {
        const input = request as unknown as { instructions: string; text: { format: { schema: { properties: { what_we_know: { maxItems: number }; what_we_dont_know: { minItems: number; maxItems: number } } } } } };
        const fields = input.text.format.schema.properties;
        assert.equal(fields.what_we_know.maxItems, version === 3 ? 0 : 5);
        assert.equal(fields.what_we_dont_know.minItems, version === 3 ? 0 : 3);
        assert.equal(fields.what_we_dont_know.maxItems, version === 3 ? 3 : 5);
        assert.match(input.instructions, version === 3 ? /optional/ : /Do not convert it/);
        return { output_text: JSON.stringify({ ...content, change_required: false }) } as never;
      });
      const result = await generateEditorialRevision({ currentContent: content, sources: [{ id: 'source-1', title: 'Mapping findings', publisher: 'Research publisher', source_type: 'primary' }], update: { sourceId: 'source-1', title: 'Follow-up', publisher: 'Research publisher', publishedAt: null, relationship: 'follow_up', rationale: null, summary: 'No material new findings.', rawContent: null } });
      assert.deepEqual(result.content, content);
      assert.equal(result.contentChanged, false);
      create.mock.restore();
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
