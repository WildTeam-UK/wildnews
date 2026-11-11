import type { Metadata } from 'next';
import { ArrowRight, BellRing, ChevronDown, FilePenLine, Search } from 'lucide-react';
import { AddToQueueButton } from '@/components/add-to-queue-button';
import { ArticleLifecycleButton } from '@/components/article-lifecycle-button';
import { AdminHeader } from '@/components/admin-header';
import { AdminNav } from '@/components/admin-nav';
import { coverageRevisionNeedsAttention, coverageUpdateNeedsAttention } from '@/lib/coverage-update-attention';
import { stripSourceMarkers } from '@/lib/article-text';
import { requireContentAdmin } from '@/lib/supabase/require-admin';
import { londonMediumDateTimeFormatter as dateTime } from '@/lib/date-format';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Articles | WILDNEWS editorial',
  robots: { index: false, follow: false },
};

type ArticleView = 'all' | 'updates' | 'unscheduled' | 'scheduled' | 'held' | 'published' | 'archived';
type QueueGroup = 'unscheduled' | 'scheduled' | 'held';

const articleViews: { value: ArticleView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'published', label: 'Published' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'unscheduled', label: 'Unscheduled' },
  { value: 'held', label: 'Held' },
  { value: 'updates', label: 'Updates available' },
  { value: 'archived', label: 'Archived' },
];
const articleStatusViews = articleViews.filter((option) => option.value !== 'updates');

function articleViewHref(view: ArticleView, search: string) {
  const query = new URLSearchParams();
  if (view !== 'all') query.set('view', view);
  if (search) query.set('q', search);
  return `/admin/drafts${query.size ? `?${query}` : ''}`;
}

function queueGroup(status?: string): QueueGroup {
  if (status === 'held') return 'held';
  if (status && ['queued', 'scheduled', 'publishing'].includes(status)) return 'scheduled';
  return 'unscheduled';
}

function queueLabel(status?: string) {
  if (status === 'scheduled') return 'Scheduled';
  if (status === 'queued') return 'Waiting for slot';
  if (status === 'publishing') return 'Publishing';
  if (status === 'held') return 'Held for review';
  return 'Draft';
}

export default async function DraftsPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const filters = await searchParams;
  const requestedView = filters.view === 'drafts' ? 'unscheduled' : filters.view;
  const view: ArticleView = articleViews.some((option) => option.value === requestedView) ? requestedView as ArticleView : 'all';
  const search = (filters.q ?? '').trim();
  const { supabase } = await requireContentAdmin();
  const { data: stories, error } = await supabase.from('stories').select('id, cluster_id, headline, standfirst, status, updated_at, published_at, primary_topic:generation_metadata->topic_classification->>primary_topic, model:generation_metadata->>model').eq('content_type', 'news').in('status', ['draft', 'published', 'archived']).order('updated_at', { ascending: false });
  if (error) throw new Error('Unable to load articles.');
  const clusterIds = (stories ?? []).flatMap((story) => story.cluster_id ? [story.cluster_id] : []);
  const storyIds = (stories ?? []).map((story) => story.id);
  const [{ data: updateRows, error: updatesError }, { data: revisionRows, error: revisionsError }, { data: updateSettings, error: updateSettingsError }] = await Promise.all([
    clusterIds.length ? supabase.from('story_cluster_updates').select('cluster_id, automation_attempt_count, automation_last_error').in('cluster_id', clusterIds).eq('status', 'pending_review') : Promise.resolve({ data: [], error: null }),
    storyIds.length ? supabase.from('story_editorial_revisions').select('story_id, created_by, automation_attempt_count, automation_last_error').in('story_id', storyIds).eq('status', 'draft') : Promise.resolve({ data: [], error: null }),
    supabase.from('editorial_run_settings').select('auto_coverage_updates_enabled').eq('id', true).maybeSingle(),
  ]);
  if (updatesError) throw new Error('Unable to load pending coverage reviews.');
  if (revisionsError) throw new Error('Unable to load editorial revisions. Run the coverage-revision migration first.');
  if (updateSettingsError) throw new Error('Unable to load article update automation settings.');
  const updateAutomationEnabled = updateSettings?.auto_coverage_updates_enabled ?? false;
  const updateCounts = new Map<string, number>();
  for (const update of updateRows ?? []) {
    if (coverageUpdateNeedsAttention(update, updateAutomationEnabled)) updateCounts.set(update.cluster_id, (updateCounts.get(update.cluster_id) ?? 0) + 1);
  }
  const revisionStoryIds = new Set((revisionRows ?? []).filter((revision) => coverageRevisionNeedsAttention(revision, updateAutomationEnabled)).map((revision) => revision.story_id));
  const drafts = stories?.filter((story) => story.status === 'draft') ?? [];
  const published = stories?.filter((story) => story.status === 'published') ?? [];
  const archived = stories?.filter((story) => story.status === 'archived') ?? [];
  const draftIds = drafts.map((draft) => draft.id);
  const { data: queueRows, error: queueError } = draftIds.length
    ? await supabase.from('publication_queue').select('id, story_id, status, scheduled_for, hold_reason').in('story_id', draftIds)
    : { data: [], error: null };
  if (queueError) throw new Error('Unable to load draft publishing statuses.');
  const queueByStory = new Map((queueRows ?? []).map((row) => [row.story_id, row]));
  const counts = {
    all: stories?.length ?? 0,
    updates: (stories ?? []).filter((story) => story.status !== 'archived' && (revisionStoryIds.has(story.id) || Boolean(story.cluster_id && updateCounts.get(story.cluster_id)))).length,
    scheduled: drafts.filter((draft) => queueGroup(queueByStory.get(draft.id)?.status) === 'scheduled').length,
    unscheduled: drafts.filter((draft) => queueGroup(queueByStory.get(draft.id)?.status) === 'unscheduled').length,
    held: drafts.filter((draft) => queueGroup(queueByStory.get(draft.id)?.status) === 'held').length,
    published: published.length,
    archived: archived.length,
  };
  const searchLower = search.toLocaleLowerCase('en-GB');
  const visibleArticles = (stories ?? []).filter((article) => {
    const group = article.status === 'draft' ? queueGroup(queueByStory.get(article.id)?.status) : null;
    const matchesView = view === 'all'
      || (view === 'updates' && article.status !== 'archived' && (revisionStoryIds.has(article.id) || Boolean(article.cluster_id && updateCounts.get(article.cluster_id))))
      || (view === 'published' && article.status === 'published')
      || (view === 'archived' && article.status === 'archived')
      || (article.status === 'draft' && group === view);
    const matchesSearch = !searchLower || `${article.headline} ${article.standfirst}`.toLocaleLowerCase('en-GB').includes(searchLower);
    return matchesView && matchesSearch;
  });
  const selectedStatus = articleStatusViews.find((option) => option.value === view) ?? articleStatusViews[0];

  return <main className="admin-page">
    <AdminHeader />
    <AdminNav active="drafts" />
    <div className="admin-shell admin-drafts-shell">
      <section className="admin-welcome candidates-heading"><div><p className="eyebrow">Editorial workspace</p><h1>Articles</h1><p>Search and manage every draft, scheduled, held and published article in one place.</p></div><div className="candidate-summary"><FilePenLine /><strong>{stories?.length ?? 0}</strong><span>total articles</span></div></section>
      {stories?.length ? <div className="draft-library-tools"><div className="draft-filter-controls"><details className="draft-status-filter"><summary><span>Status</span><strong>{selectedStatus.label}</strong><em>{counts[selectedStatus.value]}</em><ChevronDown /></summary><nav aria-label="Filter articles by status">{articleStatusViews.map((option) => <a className={view === option.value ? 'active' : ''} href={articleViewHref(option.value, search)} aria-current={view === option.value ? 'page' : undefined} key={option.value}><span>{option.label}</span><strong>{counts[option.value]}</strong></a>)}</nav></details><a className={`draft-updates-filter${view === 'updates' ? ' active' : ''}`} href={articleViewHref('updates', search)} aria-current={view === 'updates' ? 'page' : undefined}><BellRing /><span>Updates available</span><strong>{counts.updates}</strong></a></div><form action="/admin/drafts"><input type="hidden" name="view" value={view === 'all' ? '' : view} /><label><Search /><input aria-label="Search articles" name="q" defaultValue={search} placeholder="Search article titles…" /></label><button type="submit">Search</button>{search ? <a href={articleViewHref(view, '')}>Clear</a> : null}</form></div> : null}
      {!stories?.length ? <section className="source-empty candidate-empty"><FilePenLine /><h2>No articles yet</h2><p>Research a candidate, then choose Generate draft.</p></section> : visibleArticles.length ? <section className="draft-list">{visibleArticles.map((article) => {
        const updates = article.cluster_id ? updateCounts.get(article.cluster_id) ?? 0 : 0;
        const hasRevision = revisionStoryIds.has(article.id);
        const queue = article.status === 'draft' ? queueByStory.get(article.id) : null;
        const group = article.status === 'draft' ? queueGroup(queue?.status) : article.status;
        const articleStatus = article.status === 'published' ? 'Published' : article.status === 'archived' ? 'Archived' : queueLabel(queue?.status);
        const articleKind = article.status === 'published' ? 'Live article' : article.status === 'archived' ? 'Archived article' : 'Private article';
        const articleDate = article.status === 'published'
          ? `Published ${article.published_at ? dateTime.format(new Date(article.published_at)) : ''}`
          : article.status === 'archived'
            ? `Archived ${dateTime.format(new Date(article.updated_at))}${article.published_at ? ` · First published ${dateTime.format(new Date(article.published_at))}` : ''}`
            : `Updated ${dateTime.format(new Date(article.updated_at))} · ${article.model ?? 'OpenAI'}${queue?.scheduled_for ? ` · Publishes ${dateTime.format(new Date(queue.scheduled_for))}` : queue?.hold_reason ? ` · ${queue.hold_reason}` : ''}`;
        return <article key={article.id}><div><div className="draft-card-labels"><p className="eyebrow">{article.primary_topic ?? 'Conservation'} · {articleKind}</p><span className={`draft-queue-badge ${group}`}>{articleStatus}</span>{article.status !== 'archived' && hasRevision ? <span className="draft-queue-badge update-review"><FilePenLine /> Revision in progress</span> : article.status !== 'archived' && updates ? <span className="draft-queue-badge update-review"><BellRing /> {updates} new coverage {updates === 1 ? 'source' : 'sources'} to review</span> : null}</div><h2>{article.headline}</h2><p>{stripSourceMarkers(article.standfirst)}</p><small>{articleDate}</small></div><div className="draft-card-actions">{group === 'unscheduled' ? <><AddToQueueButton storyId={article.id} compact /><ArticleLifecycleButton storyId={article.id} action="archive" compact /></> : group === 'archived' ? <ArticleLifecycleButton storyId={article.id} action="restore" compact /> : null}<a href={`/admin/drafts/${article.id}`}>{hasRevision && article.status !== 'archived' ? 'Review revision' : article.status === 'published' ? 'View article controls' : article.status === 'archived' ? 'View archived article' : 'Review and edit'} <ArrowRight /></a></div></article>;
      })}</section> : <section className="source-empty candidate-empty draft-filter-empty"><Search /><h2>No matching articles</h2><p>Try another search or choose a different article status.</p></section>}
    </div>
  </main>;
}
