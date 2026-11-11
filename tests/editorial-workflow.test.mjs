/* eslint-disable unicorn/no-thenable -- Model Supabase's awaited query builder in the in-memory workflow fixture. */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const mocks = {
  '@/lib/supabase/admin': 'export const getSupabaseAdminClient = () => globalThis.editorialFixture.client;',
  '@/lib/ingestion/rss': 'export const collectEnabledSources = async () => { throw Error("Unexpected collection"); };',
  '@/lib/openai/assess-news': 'export const assessUnprocessedItems = async () => { throw Error("Unexpected assessment"); };',
  '@/lib/openai/draft-story': 'export const generateStoryDraft = async () => { globalThis.editorialFixture.aiCalls++; throw Error("Unexpected drafting"); };',
  '@/lib/openai/research-story': 'export const researchCandidate = async () => { globalThis.editorialFixture.aiCalls++; throw Error("Unexpected research"); };',
  '@/lib/publication-queue': 'export const remainingPublicationCapacityToday = async () => 10; export const queueReadyDrafts = async () => globalThis.editorialFixture.queue();',
  '@/lib/source-discovery': 'export const rebuildSourceSuggestionsFromResearch = async () => ({}); export const enrichSourceSuggestionDescriptions = async () => ({}); export const scanBestSourceSuggestions = async () => ({});',
  '@/lib/source-intelligence': 'export const refreshSourceIntelligence = async () => ({});',
};
const temporaryModules = await mkdtemp(join(tmpdir(), 'wildnews-workflow-tests-'));
let moduleIndex = 0;
after(() => rm(temporaryModules, { recursive: true, force: true }));

async function load(entry, overrides = {}) {
  const replacements = { ...mocks, ...overrides };
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'workflow-fixture', setup(builder) {
      builder.onResolve({ filter: /^(?:@\/|\.\/)/ }, (args) => {
        const path = args.path === './client' && args.importer.endsWith('/lib/openai/draft-story.ts') ? '@/lib/openai/client' : args.path;
        return replacements[path] ? { path, namespace: 'fixture' } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: replacements[args.path], loader: 'js' }));
    } }],
  });
  const modulePath = join(temporaryModules, `${moduleIndex++}.mjs`);
  await writeFile(modulePath, result.outputFiles[0].text);
  return import(pathToFileURL(modulePath).href);
}

const runner = await load('lib/editorial-runner.ts');

function fixture(drafted, cost = 0) {
  const run = { id: 'run', status: 'running', current_stage: 'researching', started_at: new Date().toISOString(), max_new_drafts: 10, max_estimated_cost_usd: 1, estimated_cost_usd: cost, candidates_selected: 20, candidates_processed: drafted, drafts_created: drafted, failures: 0, publication_queue_completed_at: null };
  const tables = {
    editorial_runs: [run],
    editorial_run_items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, run_id: 'run', cluster_id: `cluster-${index}`, rank: index + 1, status: index < drafted ? 'drafted' : 'pending', story_id: index < drafted ? `story-${index}` : null, updated_at: new Date().toISOString() })),
    editorial_run_events: [],
  };
  const f = {
    tables, run, aiCalls: 0, queueCalls: 0, queueFails: false,
    queue() { this.queueCalls++; if (this.queueFails) throw Error('Queue temporarily unavailable'); return { queued: drafted, held: 0, scheduled: Math.min(10, drafted) }; },
    client: {
      rpc: async (name) => ({ data: name === 'claim_editorial_run_step' ? 'token' : true, error: null }),
      from(table) {
        let rows = tables[table] ?? [];
        const filters = [];
        let mutation;
        let one = false;
        const query = {
          select() { return this; }, order() { return this; }, limit() { return this; },
          eq(key, value) { filters.push((row) => row[key] === value); return this; },
          in(key, values) { filters.push((row) => values.includes(row[key])); return this; },
          is(key, value) { filters.push((row) => row[key] === value); return this; },
          lt(key, value) { filters.push((row) => row[key] < value); return this; },
          gte(key, value) { filters.push((row) => row[key] >= value); return this; },
          not(key, _operator, value) { filters.push((row) => row[key] !== value); return this; },
          update(value) { mutation = value; return this; },
          upsert(value) { const existing = rows.find((row) => row.story_id === value.story_id); if (existing) Object.assign(existing, value); else rows.push({ id: 'queue-entry', created_at: new Date().toISOString(), ...value }); return this; },
          insert(value) { rows.push({ ...value, created_at: new Date().toISOString() }); return this; },
          single() { one = true; return this; },
          maybeSingle() { one = true; return this; },
          then(resolve, reject) {
            try {
              rows = rows.filter((row) => filters.every((filter) => filter(row)));
              if (mutation) rows.forEach((row) => Object.assign(row, mutation));
              return Promise.resolve({ data: structuredClone(one ? rows[0] ?? null : rows), count: rows.length, error: null }).then(resolve, reject);
            } catch (error) { return Promise.reject(error).then(resolve, reject); }
          },
        };
        return query;
      },
    },
  };
  globalThis.editorialFixture = f;
  return f;
}

test('an overfilled run finishes at ten drafts without spending on pending candidates', async () => {
  const f = fixture(10);
  await runner.advanceEditorialRun('run', null);
  assert.equal(f.aiCalls, 0);
  assert.equal(f.run.status, 'completed');
  assert.equal(f.queueCalls, 1);
  assert.ok(f.run.publication_queue_completed_at);
});

test('a budget stop hands off completed drafts through the existing checked queue', async () => {
  const f = fixture(3, 0.98);
  await runner.advanceEditorialRun('run', null);
  assert.equal(f.run.status, 'budget_stopped');
  assert.equal(f.aiCalls, 0);
  assert.equal(f.queueCalls, 1);
  assert.ok(f.run.publication_queue_completed_at);
});

test('an interrupted queue handoff is retried by the heartbeat and becomes idempotent', async () => {
  const f = fixture(3, 0.98);
  f.queueFails = true;
  await runner.advanceEditorialRun('run', null);
  assert.equal(f.run.publication_queue_completed_at, null);
  f.queueFails = false;
  await runner.recoverEditorialRunPublication();
  assert.ok(f.run.publication_queue_completed_at);
  await runner.finalizeEditorialRunPublication('run');
  assert.equal(f.queueCalls, 2);
});

test('an editor resuming today’s budget-stopped run reopens its publication handoff', async () => {
  const f = fixture(3, 0.98);
  f.run.status = 'budget_stopped';
  f.run.publication_queue_completed_at = new Date().toISOString();
  f.tables.editorial_run_settings = [];
  await runner.startEditorialRun('editor', 10, 2);
  assert.equal(f.run.status, 'running');
  assert.equal(f.run.publication_queue_completed_at, null);
  assert.equal(f.queueCalls, 0);
});

test('an old run stops before doing AI work on the new day', async () => {
  const f = fixture(3);
  f.run.started_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await runner.advanceEditorialRun('run', null);
  assert.equal(f.run.status, 'partial');
  assert.equal(f.aiCalls, 0);
});

test('the real queue preserves content, taxonomy, score and three-source admission checks', async () => {
  const queue = await load('lib/publication-queue.ts');
  const content = {
    template_version: 2, topics: ['Wildlife'], headline: 'A sourced conservation development', standfirst: 'An attributed briefing.',
    story_at_a_glance: [{ text: 'Overview one' }, { text: 'Overview two' }],
    key_takeaways: Array.from({ length: 5 }, () => ({ text: 'Evidence' })),
    why_it_matters: { text: 'Significance' }, what_happens_next: { text: 'Next steps' },
    what_we_know: [{ text: 'Known' }], what_we_dont_know: [{ text: 'Unknown' }],
    coverage_analysis: { one: 70, two: 70, three: 70 },
    image_url: 'https://example.org/image.jpg', image_alt: 'Habitat', image_credit: { creator_name: 'Photographer', source_name: 'Source' },
    seo_title: 'Conservation development', seo_description: 'A source-linked conservation briefing.',
  };
  for (const scenario of ['valid', 'missing-image', 'two-sources', 'low-score', 'taxonomy-review']) {
    const f = fixture(1);
    const article = structuredClone(content);
    if (scenario === 'missing-image') article.image_url = '';
    f.tables.stories = [{ id: 'story-0', cluster_id: 'cluster-0', status: 'draft', created_at: new Date().toISOString(), generation_metadata: { article_content: article }, taxonomy_review_required: scenario === 'taxonomy-review' }];
    f.tables.story_clusters = [{ id: 'cluster-0', overall_score: scenario === 'low-score' ? 10 : 70, evidence_score: 70 }];
    f.tables.story_sources = Array.from({ length: scenario === 'two-sources' ? 2 : 3 }, () => ({ story_id: 'story-0' }));
    f.tables.publication_queue = [];
    f.tables.editorial_run_settings = [{ id: true, auto_publish_enabled: true, publish_window_start: '08:00', publish_window_end: '20:00', max_new_drafts: 10, min_auto_publish_overall_score: 55, min_auto_publish_evidence_score: 40 }];
    const result = await queue.queueReadyDrafts('run');
    assert.equal(result.held, scenario === 'valid' ? 0 : 1, scenario);
    assert.equal(result.queued, scenario === 'valid' ? 1 : 0, scenario);
    assert.equal(f.tables.stories[0].status, 'draft');
  }
});

test('resumed runs count their own queued drafts once and still respect other daily publications', async () => {
  const queue = await load('lib/publication-queue.ts');
  const f = fixture(3);
  const now = new Date().toISOString();
  f.tables.publication_queue = [0, 1, 2].map((index) => ({ story_id: `story-${index}`, status: 'scheduled', scheduled_for: now }));
  f.tables.stories = [
    { id: 'story-0', status: 'published', content_type: 'news', published_at: now },
    { id: 'other-run-story', status: 'published', content_type: 'news', published_at: now },
  ];
  assert.equal(await queue.remainingPublicationCapacityToday(10), 6);
  assert.equal(await queue.remainingPublicationCapacityToday(10, 'run'), 9);
});

test('a late AI draft cannot be saved after the run loses its lease', async () => {
  const f = fixture(0);
  f.tables.stories = [];
  f.tables.story_clusters = [{ id: 'cluster-0', working_title: 'Conservation development', status: 'selected', assessment: {} }];
  f.tables.research_packs = [{ cluster_id: 'cluster-0', id: 'pack', status: 'completed', content: {
    sources: [{ url: 'https://example.org/source' }], key_facts: [], areas_of_agreement: [], disputed_points: [], open_questions: [], tags: [],
    topic_classification: { review_required: false, primary_topic: 'Wildlife', secondary_topics: [], confidence: 90 }, coverage_analysis: {},
  } }];
  f.tables.training_courses = [];
  f.tables.story_cluster_tags = [];
  const text = { text: 'Evidence from the supplied source. '.repeat(10), source_ids: ['source-1'] };
  f.generatedDraft = { headline: 'A conservation development', standfirst: 'A briefing', story_at_a_glance: [text, text], key_takeaways: [text, text, text, text, text], why_it_matters: text, what_happens_next: text, what_we_know: [], what_we_dont_know: [], seo_title: 'Development', seo_description: 'Briefing', image_search_query: 'forest', image_search_fallbacks: [], conservation_outlook: { classification: 'neutral', score: 50, confidence: 80, rationale: 'Evidence' }, course_recommendation: { course_id: '', confidence: 0, rationale: 'No relevant course' } };
  const draft = await load('lib/openai/draft-story.ts', {
    '@/lib/openai/client': 'export const getOpenAIClient = () => ({ responses: { create: async () => ({ output_text: JSON.stringify(globalThis.editorialFixture.generatedDraft), usage: {} }) } });',
    '@/lib/images/unsplash': 'export const unsplashIsConfigured = () => false; export const searchUnsplashImages = async () => []; export const recordUnsplashSelection = async () => {};',
  });
  await assert.rejects(draft.generateStoryDraft('cluster-0', null, { beforeSave: async () => { throw Error('Lease replaced'); } }), /Lease replaced/);
  assert.equal(f.tables.stories.length, 0);
});

// Exercise the real digest query. A previous day's news and today's digest
// cannot satisfy tomorrow's minimum, and generation must not fall back to them.
test('the next daily digest refuses old stories rather than repeating the previous edition', async () => {
  const queries = [];
  const start = '2026-11-11T09:00:00Z';
  const end = '2026-11-12T09:00:00Z';
  const records = [
    { id: 'old-news', status: 'published', content_type: 'news', published_at: '2026-11-10T18:00:00Z' },
    { id: 'today-digest', status: 'published', content_type: 'daily_digest', published_at: '2026-11-11T09:01:00Z' },
    { id: 'private-draft', status: 'draft', content_type: 'news', published_at: null },
  ];
  globalThis.editorialFixture = { client: { from(table) {
    const filters = [];
    const query = {
      select() { return this; }, order() { return this; }, limit() { return this; },
      eq(key, value) { filters.push((row) => row[key] === value); queries.push([key, '=', value]); return this; },
      gte(key, value) { filters.push((row) => row[key] >= value); queries.push([key, '>=', value]); return this; },
      lt(key, value) { filters.push((row) => row[key] < value); queries.push([key, '<', value]); return this; },
      single: async () => ({ data: { daily_min_stories: 3, daily_max_stories: 10 }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve, reject) { return Promise.resolve({ data: table === 'stories' ? records.filter((row) => filters.every((filter) => filter(row))) : [], error: null }).then(resolve, reject); },
    };
    return query;
  } } };
  const digest = await load('lib/openai/generate-digest.ts', { '@/lib/openai/client': 'export const getOpenAIClient = () => { throw Error("Unexpected AI call"); };' });
  await assert.rejects(digest.generateDigest('daily', null, { periodStart: start, periodEnd: end, triggerType: 'scheduled' }), /Only 0 eligible stories were published/);
  assert.ok(queries.some(([key, operator, value]) => key === 'published_at' && operator === '>=' && value === new Date(start).toISOString()));
  assert.ok(queries.some(([key, operator, value]) => key === 'published_at' && operator === '<' && value === new Date(end).toISOString()));
  assert.ok(queries.some(([key, , value]) => key === 'content_type' && value === 'news'));
});
