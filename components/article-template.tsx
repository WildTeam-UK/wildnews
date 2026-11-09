/* oxlint-disable next/no-html-link-for-pages -- full page loads avoid unreliable Vinext client navigation */
import { ArrowRight, CircleHelp, ExternalLink } from 'lucide-react';
import { ContextualLinkedText } from '@/components/contextual-linked-text';
import { EditorialImage } from '@/components/editorial-image';
import { EditorialImageCredit } from '@/components/editorial-image-credit';
import { SocialShare } from '@/components/social-share';
import { TopicTag } from '@/components/topic-tag';
import { stripSourceMarkers } from '@/lib/article-text';
import type { EditorialImageCredit as EditorialImageCreditData } from '@/lib/images/types';
import { CoursePromotion } from '@/components/course-promotion';
import { GENERAL_TRAINING_PROMOTION, type TrainingCoursePromotion } from '@/lib/training-courses';
import type { ArticleContextualLink } from '@/lib/article-linking';
import { GoodNewsBadge } from '@/components/good-news-badge';
import { londonLongDateFormatter } from '@/lib/date-format';
import { ContentFeedback } from '@/components/content-feedback';
import { ContentViewTracker } from '@/components/content-view-tracker';
import { TrackedInteractionLink } from '@/components/tracked-interaction-link';
import { StoryUpdateHistory } from '@/components/story-update-history';

export type ArticleCoverage = {
  ecological: number;
  evidence: number;
  consensus: number;
};

export type ArticleText = string | { text: string; sourceIds?: string[]; links?: ArticleContextualLink[] };

type ArticleSource = { id?: string; recordId?: string; name: string; title?: string; url: string; primary?: boolean };

export type ArticleTemplateData = {
  templateVersion?: 2 | 3;
  topics: string[];
  discoveryTags?: { name: string; slug: string }[];
  headline: string;
  storyAtAGlance: ArticleText[];
  imageUrl?: string;
  imageAlt?: string;
  imageCredit?: EditorialImageCreditData | null;
  updatedAt: string;
  publishedAt?: string;
  editorialUpdates?: { date: string; summary: string; sourceIds: string[]; sourceOnly: boolean }[];
  keyTakeaways: ArticleText[];
  whyItMatters: ArticleText;
  whatHappensNext: ArticleText;
  whatWeKnow: ArticleText[];
  whatWeDontKnow: ArticleText[];
  sources: ArticleSource[];
  coverage: ArticleCoverage;
  coursePromotion?: TrainingCoursePromotion | null;
  goodNews?: boolean;
};

function CoverageHelp({ label, text }: { label: string; text: string }) {
  return <button className="analysis-help coverage-help" type="button" aria-label={`${label}: ${text}`}><CircleHelp aria-hidden="true" /><span className="analysis-tooltip" role="tooltip">{text}</span></button>;
}

function BinaryAnalysis({ title, firstLabel, firstValue, secondLabel, tooltip, tone }: { title: string; firstLabel: string; firstValue: number; secondLabel: string; tooltip: string; tone: string }) {
  const secondValue = 100 - firstValue;
  return <section className="coverage-dimension">
    <div className="coverage-dimension-heading"><h2>{title}</h2><CoverageHelp label={title} text={tooltip} /></div>
    <div className={`lean-bar coverage-signal-bar ${tone}`} aria-label={`${firstLabel} ${firstValue}%, ${secondLabel} ${secondValue}%`}><span style={{ width: `${firstValue}%` }} /><span style={{ width: `${secondValue}%` }} /></div>
    <div className="coverage-signal-labels"><span>{firstLabel} <strong>{firstValue}%</strong></span><span>{secondLabel} <strong>{secondValue}%</strong></span></div>
  </section>;
}

function CoverageSummaryBinary({ title, firstLabel, firstValue, secondLabel, tone }: { title: string; firstLabel: string; firstValue: number; secondLabel: string; tone: string }) {
  const secondValue = 100 - firstValue;
  return <section className="article-coverage-item">
    <div className="article-coverage-item-heading"><span>{title}</span><strong>{firstValue} / {secondValue}</strong></div>
    <div className={`lean-bar coverage-summary-bar ${tone}`} aria-label={`${firstLabel} ${firstValue}%, ${secondLabel} ${secondValue}%`}><span style={{ width: `${firstValue}%` }} /><span style={{ width: `${secondValue}%` }} /></div>
    <div className="coverage-summary-mini-labels"><span>{firstLabel}</span><span>{secondLabel}</span></div>
  </section>;
}

function formattedDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return londonLongDateFormatter.format(date);
}

function articleTextValue(value: ArticleText) {
  const text = typeof value === 'string' ? value : value.text;
  return stripSourceMarkers(text);
}

function SourceReferenceLinks({ sourceIds, sources, storyId }: { sourceIds: string[]; sources: Map<string, ArticleSource>; storyId?: string }) {
  return sourceIds.length ? <span className="article-source-refs" aria-label="Supporting sources">{sourceIds.map((id) => {
    const source = sources.get(id);
    return source ? storyId && source.recordId
      ? <TrackedInteractionLink href={source.url} target="_blank" rel="noopener noreferrer" storyId={storyId} storySourceId={source.recordId} eventType="outbound_source" title={`${source.name}${source.title ? `: ${source.title}` : ''}`} aria-label={`Source ${id.replace('source-', '')}: ${source.name}`} key={id}>{id.replace('source-', '')}</TrackedInteractionLink>
      : <a href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.name}${source.title ? `: ${source.title}` : ''}`} aria-label={`Source ${id.replace('source-', '')}: ${source.name}`} key={id}>{id.replace('source-', '')}</a> : null;
  })}</span> : null;
}

function ArticleTextContent({ value, sources, storyId }: { value: ArticleText; sources: Map<string, ArticleSource>; storyId?: string }) {
  const sourceIds = typeof value === 'string' ? [] : [...new Set(value.sourceIds ?? [])];
  const text = articleTextValue(value);
  const links = typeof value === 'string' ? [] : value.links;
  return <><ContextualLinkedText text={text} links={links} />{sourceIds.length ? <> <SourceReferenceLinks sourceIds={sourceIds} sources={sources} storyId={storyId} /></> : null}</>;
}

export function ArticleTemplate({ article, storyId, sharePath }: { article: ArticleTemplateData; storyId?: string; sharePath?: string }) {
  const { coverage } = article;
  const editorialUpdates = article.editorialUpdates ?? [];
  const latestEditorialUpdate = editorialUpdates[0];
  const sourcesById = new Map(article.sources.flatMap((source) => source.id ? [[source.id, source] as const] : []));
  return <article className="article-template">
    {storyId ? <ContentViewTracker storyId={storyId} /> : null}
    <header className="article-hero shell">
      <div className="article-topics">{article.goodNews ? <GoodNewsBadge href="/good-news-in-conservation" /> : null}{article.topics.map((topic) => <TopicTag topic={topic} key={topic} />)}</div>
      <h1>{article.headline}</h1>
      <div className="article-coverage-summary" aria-label="Coverage analysis summary">
        <div className="coverage-summary-heading"><span>Coverage mix</span><a className="analysis-help" href="/how-coverage-analysis-works" aria-label="Learn how our coverage analysis works"><CircleHelp /><span className="analysis-tooltip" role="tooltip">A quick view of the ecological, evidence and consensus signals found across current coverage. Click to learn how it works.</span></a></div>
        <div className="article-coverage-track">
          <CoverageSummaryBinary title="Ecological / Economic" firstLabel="Ecological" firstValue={coverage.ecological} secondLabel="Economic" tone="ecology-signal" />
          <CoverageSummaryBinary title="Evidence / Opinion" firstLabel="Evidence" firstValue={coverage.evidence} secondLabel="Opinion" tone="evidence-signal" />
          <CoverageSummaryBinary title="Consensus / Contested" firstLabel="Consensus" firstValue={coverage.consensus} secondLabel="Contested" tone="consensus-signal" />
        </div>
      </div>
    </header>
    <figure className={`article-lead-image${article.imageUrl ? '' : ' article-lead-placeholder'}`}>{article.imageUrl ? <><EditorialImage src={article.imageUrl} alt={article.imageAlt?.trim() || `Illustrative image for ${article.headline}`} loading="eager" fetchPriority="high" decoding="async" />{article.goodNews ? <GoodNewsBadge overlay /> : null}<EditorialImageCredit credit={article.imageCredit} /></> : <span>Lead image to be selected</span>}</figure>
    <section className="article-overview shell">
      <div className="article-overview-meta">{article.discoveryTags?.length ? <div className="article-discovery-tags" aria-label="Explore related subjects">{article.discoveryTags.map((tag) => <a href={`/tags/${tag.slug}`} key={tag.slug}>{tag.name}</a>)}</div> : <span aria-hidden="true" />}{latestEditorialUpdate && article.publishedAt ? <StoryUpdateHistory publishedDate={formattedDate(article.publishedAt)} updatedDate={formattedDate(latestEditorialUpdate.date)}>{editorialUpdates.map((update, index) => <article key={`${update.date}-${index}`}><time dateTime={update.date}>{formattedDate(update.date)}</time><p>{update.summary}{update.sourceIds.length ? <> <SourceReferenceLinks sourceIds={update.sourceIds} sources={sourcesById} storyId={storyId} /></> : null}</p></article>)}</StoryUpdateHistory> : <p className="story-update-note">Published {formattedDate(article.publishedAt ?? article.updatedAt)}. This story may be updated as it develops.</p>}</div>
      <h2>The story at a glance</h2>
      <div className="article-overview-reading">
        {sharePath ? <SocialShare path={sharePath} title={article.headline} storyId={storyId} /> : null}
        <div className="article-overview-copy">{article.storyAtAGlance.map((paragraph, index) => <p key={`overview-${index}`}><ArticleTextContent value={paragraph} sources={sourcesById} storyId={storyId} /></p>)}</div>
      </div>
    </section>
    <div className="article-layout shell">
      <div className="article-main">
        <section className="story-section"><h2>What you need to know</h2><ul className="key-points">{article.keyTakeaways.map((point, index) => <li key={`takeaway-${index}`}><ArticleTextContent value={point} sources={sourcesById} storyId={storyId} /></li>)}</ul></section>
        <section className="story-section"><h2>Why this matters</h2><p className="story-explainer"><ArticleTextContent value={article.whyItMatters} sources={sourcesById} storyId={storyId} /></p></section>
        {articleTextValue(article.whatHappensNext) ? <section className="story-section"><h2>What happens next</h2><p className="story-explainer"><ArticleTextContent value={article.whatHappensNext} sources={sourcesById} storyId={storyId} /></p></section> : null}
        {article.templateVersion !== 3 ? <section className="story-section"><h2>What we know</h2><ul className="evidence-points">{article.whatWeKnow.map((point, index) => <li key={`known-${index}`}><ArticleTextContent value={point} sources={sourcesById} storyId={storyId} /></li>)}</ul></section> : null}
        {article.templateVersion !== 3 || article.whatWeDontKnow.length ? <section className="story-section"><h2>{article.templateVersion === 3 ? "What's still unclear" : "What we don't know"}</h2><ul className="evidence-points">{article.whatWeDontKnow.map((point, index) => <li key={`unknown-${index}`}><ArticleTextContent value={point} sources={sourcesById} storyId={storyId} /></li>)}</ul></section> : null}
        <section className="story-section" id="sources"><h2>Read the reporting</h2><p className="source-transparency-note">This WildNews briefing synthesises and summarises reporting from the sources below. WildNews did not produce the original reporting. <a href="/how-we-use-ai">Learn more about how we use AI <ArrowRight /></a></p><div className="source-list">{article.sources.map((source, index) => storyId && source.recordId ? <TrackedInteractionLink href={source.url} target="_blank" rel="noopener noreferrer" storyId={storyId} storySourceId={source.recordId} eventType="outbound_source" key={`${source.url}-${index}`} title={source.title}><span>{source.primary ? 'Primary story' : 'Also covering'}</span><strong>{source.name}</strong><ExternalLink /></TrackedInteractionLink> : <a href={source.url} target="_blank" rel="noopener noreferrer" key={`${source.url}-${index}`} title={source.title}><span>{source.primary ? 'Primary story' : 'Also covering'}</span><strong>{source.name}</strong><ExternalLink /></a>)}</div></section>
        {storyId ? <ContentFeedback storyId={storyId} contentLabel="story" /> : null}
      </div>
      <div className="article-sidebar"><aside className="coverage-card">
        <p className="eyebrow">Coverage analysis</p>
        <BinaryAnalysis title="Ecological / Economic" firstLabel="Ecological" firstValue={coverage.ecological} secondLabel="Economic" tone="ecology-signal" tooltip="Shows whether coverage primarily frames the story around environmental outcomes or economic impacts such as costs, jobs, industry and development." />
        <BinaryAnalysis title="Evidence-led / Opinion-led" firstLabel="Evidence-led" firstValue={coverage.evidence} secondLabel="Opinion-led" tone="evidence-signal" tooltip="Shows how strongly the coverage relies on research, data and attributable evidence versus commentary, interpretation or argument." />
        <BinaryAnalysis title="Consensus / Contested" firstLabel="Consensus" firstValue={coverage.consensus} secondLabel="Contested" tone="consensus-signal" tooltip="Shows how much agreement exists across the sources and viewpoints represented in current coverage. This refers to coverage consensus, not scientific consensus." />
        <small>Coverage analysis reflects the sources, framing and viewpoints currently represented in this story. These signals are not judgements of factual accuracy and may change as new reporting and sources are added.</small>
        <a className="analysis-link" href="/how-coverage-analysis-works">How our coverage analysis works <ArrowRight /></a>
      </aside><CoursePromotion course={article.coursePromotion ?? GENERAL_TRAINING_PROMOTION} /></div>
    </div>
  </article>;
}
