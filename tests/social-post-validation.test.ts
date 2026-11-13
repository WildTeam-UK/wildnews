import assert from 'node:assert/strict';
import test from 'node:test';
import type { DigestContent, DigestType } from '@/lib/digests';
import { renderSocialPost, reviewedSocialPost, socialReviewPostSchema, socialClaimMatchesProse, socialDigestLinkLine, validateRenderedSocialPost, validateSocialPostDraft, type SocialEditorialInput, type SocialEvidenceStory, type SocialPostDraft } from '@/lib/openai/generate-social-post';

function content(type: DigestType): DigestContent {
  return {
    template_version: 3,
    digest_type: type,
    edition_label: 'Test edition',
    headline: 'Evidence and action shape conservation decisions',
    standfirst: 'A source-grounded test digest.',
    introduction: ['Introduction one.', 'Introduction two.'],
    sections: [{ heading: 'Evidence', paragraphs: ['Supported digest copy.', 'More supported digest copy.'], story_ids: ['story-1'] }],
    what_to_watch: ['Further monitoring.'],
    seo_title: 'Test digest',
    seo_description: 'Test digest description.',
  };
}

function story(id: string): SocialEvidenceStory {
  return { id, digest_reference_id: id, headline: `Story ${id}`, standfirst: 'A supported development.', overview: '', key_takeaways: [], story_at_a_glance: [], why_it_matters: '', what_happens_next: '' };
}

function input(type: DigestType, storyCount: number): SocialEditorialInput {
  return {
    type,
    editionDate: '2026-10-24',
    canonicalUrl: `https://news.wildteam.org.uk/${type}-digest/2026-10-24`,
    content: content(type),
    stories: Array.from({ length: storyCount }, (_, index) => story(`story-${index + 1}`)),
    recentPosts: ['Wetland monitoring is changing how restoration teams judge progress.'],
  };
}

void test('review evidence is required inside every opening and body paragraph', () => {
  const schema = socialReviewPostSchema('daily', ['story-1', 'story-2', 'story-3']);
  for (const paragraph of [schema.properties.opening, schema.properties.paragraphs.items]) {
    assert.deepEqual(paragraph.required, ['text', 'story_ids']);
    assert.equal(paragraph.properties.story_ids.minItems, 1);
    assert.deepEqual(paragraph.properties.story_ids.items.enum, ['story-1', 'story-2', 'story-3']);
    assert.equal(paragraph.additionalProperties, false);
  }
  const { draft, claimSupport } = reviewedSocialPost({
    decision: 'revised', issues: ['Retained uncertainty.'],
    post: {
      approach: 'thematic', featured_story_ids: ['story-1', 'story-2', 'story-3'],
      opening: { text: '🌳 Evidence supports a cautious conclusion.', story_ids: ['story-1', 'story-2'] },
      paragraphs: [
        { text: '🔬 Tests remain preliminary.', story_ids: ['story-1'] },
        { text: '🌊 Monitoring continues.', story_ids: ['story-2', 'story-3'] },
      ], hashtags: ['#WildNews', '#Conservation'],
    },
  });
  assert.deepEqual(claimSupport.map((item) => item.claim), [draft.opening, ...draft.paragraphs]);
  assert.equal(claimSupport.length, 3);
  assert.deepEqual(claimSupport[2].story_ids, ['story-2', 'story-3']);
});

void test('accepts a substantive daily editorial post', () => {
  const draft: SocialPostDraft = {
    approach: 'news_briefing',
    featured_story_ids: ['story-1', 'story-2', 'story-3', 'story-4'],
    opening: '🌊 Pollution findings are putting the distance between environmental rules and practical protection under sharper scrutiny.',
    paragraphs: [
      '🏖️ Oil reached beaches in the UAE, where coastal closures, containment and assessment work followed. The available reporting did not establish the full ecological impact, so the condition of nearby sensitive habitats remained uncertain.',
      '🧪 In Zambia, early tests found elevated turbidity and conductivity after a discharge reached streams connected to the Kafue River. Heavy-metal results were still pending, while the mine operator disputed responsibility.',
      '⚖️ In England, the High Court found that Natural England had not taken sufficient active steps to protect Catfield Fen from nutrient pollution. The judgment did not prescribe the response or show that the fen had recovered.',
      '🐦 A Cornwall trial also found fewer auk captures when fishing vessels used kites or eye-patterned buoys. It was an encouraging result, but wider testing is still needed before the approach can be treated as proven across fisheries.',
    ],
    hashtags: ['#WildNews', '#Conservation', '#Wildlife'],
  };
  const dailyInput = input('daily', 4);
  assert.deepEqual(validateSocialPostDraft(draft, dailyInput), []);
  const rendered = renderSocialPost(draft, dailyInput);
  assert.equal(rendered.split('\n\n')[1], socialDigestLinkLine(dailyInput));
  assert.deepEqual(validateRenderedSocialPost(rendered, dailyInput), []);
  assert.ok(validateRenderedSocialPost(rendered.replace(dailyInput.canonicalUrl, 'https://example.com'), dailyInput).some((issue) => issue.includes('exactly once')));
});

void test('treats the target length as guidance while retaining a 300-word safety ceiling', () => {
  const dailyInput = input('daily', 3);
  const flexibleDraft: SocialPostDraft = {
    approach: 'story_led',
    featured_story_ids: ['story-1', 'story-2', 'story-3'],
    opening: '🌱 A closely watched recovery effort is revealing how much patient evidence matters for conservation decisions.',
    paragraphs: [
      '🔬 Researchers recorded a meaningful change at the first site, while stressing that the result remains preliminary and needs further monitoring before it can demonstrate lasting recovery. The work offers a useful indication of progress without resolving the larger question of whether the intervention will remain effective across seasons, habitats and different operating conditions.',
      '🛠️ A second project reached an important implementation milestone after local partners completed the planned fieldwork. Its published evidence describes what was delivered and the immediate observations, but it does not yet establish the longer-term ecological outcome or show that the same approach would work elsewhere without adaptation.',
      '📋 Elsewhere, a proposed protection measure moved into consultation. The proposal could alter how damaging activity is managed if adopted, although the available material does not confirm its final form, timetable or practical effect. Those distinctions matter when early policy movement is reported alongside completed conservation action.',
      '📊 Taken together, the developments show why credible progress depends on distinguishing encouraging signals, completed work and confirmed outcomes. Each can be important, but they answer different questions and require different evidence before stronger conclusions are justified. Continued reporting will be especially useful where ecological responses unfold slowly and initial observations cannot yet resolve the central conservation question.',
    ],
    hashtags: ['#WildNews', '#Conservation'],
  };
  const flexibleWordCount = [flexibleDraft.opening, ...flexibleDraft.paragraphs, 'Read the latest WildNews daily digest'].join(' ').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  assert.ok(flexibleWordCount > 205 && flexibleWordCount <= 300);
  assert.deepEqual(validateSocialPostDraft(flexibleDraft, dailyInput), []);

  const excessiveDraft = { ...flexibleDraft, paragraphs: [...flexibleDraft.paragraphs, `Additional ${'evidence '.repeat(100)}`] };
  assert.ok(validateSocialPostDraft(excessiveDraft, dailyInput).some((issue) => issue.includes('300')));
});

void test('accepts close review excerpts but rejects unrelated claim support', () => {
  const prose = [
    'Early tests found elevated turbidity and conductivity after a discharge reached streams connected to the Kafue River.',
    'Heavy-metal results were still pending, while the mine operator disputed responsibility.',
  ];
  assert.equal(socialClaimMatchesProse('Tests found elevated turbidity and conductivity in streams connected with the Kafue River.', prose), true);
  assert.equal(socialClaimMatchesProse('Claim: early tests found elevated turbidity and conductivity after discharge reached streams connected with the Kafue River.', prose), true);
  assert.equal(socialClaimMatchesProse('connected to the Kafue River Heavy metal results were still pending', prose), true);
  assert.equal(socialClaimMatchesProse('A coral restoration project reported successful spawning across three reefs.', prose), false);
});

void test('accepts a reflective weekly editorial post', () => {
  const draft: SocialPostDraft = {
    approach: 'thematic',
    featured_story_ids: ['story-1', 'story-2', 'story-3', 'story-4', 'story-5'],
    opening: '📊 Some of conservation’s most encouraging numbers also carried the strongest reasons to look beyond a headline result.',
    paragraphs: [
      '🌳 Brazil recorded the lowest annual deforestation figures in its monitoring series for the Amazon and Cerrado. The decline was substantial, although the measure did not capture every form of degradation or establish which policies caused the change.',
      '🪸 A global coral assessment classified most shallow-water reef regions as facing a high risk of collapse when projected heat stress was included. That classification described risk under a specified scenario, not reefs that had already collapsed.',
      '🐆 Captive-origin cheetahs reproduced after phased releases in South Africa, with 33 independent descendants joining the managed metapopulation. That is an encouraging milestone, but reproduction alone does not demonstrate long-term population recovery.',
      '💵 A Peru pilot associated unconditional payments and voluntary training with improved household wellbeing and greater reported participation in conservation practices. It did not directly measure forest condition or separate the effects of cash from training.',
      '🔥 Four responders died and two were severely burned while fighting a wildfire in Mount Bromo National Park. The cause and circumstances remained under investigation, underlining that conservation delivery must account for people’s safety as well as intended environmental benefits.',
      '🔎 Across these developments, the practical lesson is consistent: indicators, births and promising interventions matter, but monitoring must still show whether they lead to durable ecological outcomes and whether an approach works at the scale claimed.',
    ],
    hashtags: ['#WildNews', '#Conservation', '#Biodiversity'],
  };
  assert.deepEqual(validateSocialPostDraft(draft, input('weekly', 5)), []);
});

void test('rejects generic, relative and unsupported social formatting', () => {
  const draft: SocialPostDraft = {
    approach: 'news_briefing',
    featured_story_ids: ['story-1', 'story-2', 'missing-story'],
    opening: "😂 Welcome to today's digest",
    paragraphs: ['**Big news** is everywhere.', 'Read more at https://example.com.'],
    hashtags: ['#Conservation'],
  };
  const issues = validateSocialPostDraft(draft, input('daily', 3));
  assert.ok(issues.some((issue) => issue.includes('generic publication announcement')));
  assert.ok(issues.some((issue) => issue.includes('relative date')));
  assert.ok(issues.some((issue) => issue.includes('outside the published digest evidence')));
  assert.ok(issues.some((issue) => issue.includes('unsupported Markdown')));
  assert.ok(issues.some((issue) => issue.includes('#WildNews')));
  assert.ok(issues.some((issue) => issue.includes('inappropriate reaction')));
});

void test('requires one distinct leading emoji in every editorial paragraph', () => {
  const dailyInput = input('daily', 3);
  const draft: SocialPostDraft = {
    approach: 'news_briefing',
    featured_story_ids: ['story-1', 'story-2', 'story-3'],
    opening: 'A habitat recovery programme has reached its first monitoring milestone after an extended field season.',
    paragraphs: [
      'Researchers recorded the first set of results while stressing that longer monitoring is needed before drawing conclusions about recovery.',
      'A second team completed planned restoration work, but the available evidence does not yet establish the ecological outcome.',
    ],
    hashtags: ['#WildNews', '#Conservation'],
  };
  assert.ok(validateSocialPostDraft(draft, dailyInput).some((issue) => issue.includes('Every editorial paragraph must begin')));
  const misplaced = { ...draft, opening: 'A 🌱 habitat recovery programme has reached its first monitoring milestone after an extended field season.', paragraphs: ['🌳 Researchers recorded the first set of results while stressing that longer monitoring is needed before drawing conclusions about recovery.', '🌊 A second team completed planned restoration work, but the available evidence does not yet establish the ecological outcome.'] };
  assert.ok(validateSocialPostDraft(misplaced, dailyInput).some((issue) => issue.includes('must begin')));
  const repeated = { ...draft, opening: '🌱 A habitat recovery programme has reached its first monitoring milestone after an extended field season.', paragraphs: ['🌱 Researchers recorded the first set of results while stressing that longer monitoring is needed before drawing conclusions about recovery.', '🌊 A second team completed planned restoration work, but the available evidence does not yet establish the ecological outcome.'] };
  assert.ok(validateSocialPostDraft(repeated, dailyInput).some((issue) => issue.includes('different relevant emoji')));
  const unrelatedFire = { ...draft, opening: '🔥 A habitat recovery programme has reached its first monitoring milestone after an extended field season.', paragraphs: ['🌳 Researchers recorded the first set of results while stressing that longer monitoring is needed before drawing conclusions about recovery.', '🌊 A second team completed planned restoration work, but the available evidence does not yet establish the ecological outcome.'] };
  assert.ok(validateSocialPostDraft(unrelatedFire, dailyInput).some((issue) => issue.includes('fire emoji')));
});
