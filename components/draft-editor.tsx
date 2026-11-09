'use client';

import { type SyntheticEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ImageIcon, LoaderCircle, RotateCcw, Save, Search, ShieldCheck, X } from 'lucide-react';
import { ArticleTemplate, type ArticleTemplateData } from '@/components/article-template';
import type { EditorialImageCredit, UnsplashImageCandidate } from '@/lib/images/types';
import type { DraftCoverageAnalysis, SourcedDraftText, StoryDraftContent } from '@/lib/openai/draft-story';
import { EDITORIAL_TOPICS } from '@/lib/taxonomy';
import type { TrainingCoursePromotion } from '@/lib/training-courses';

export type DraftSource = { id: string; title: string; publisher: string; url: string; source_type: string; source_item_id?: string; published_at?: string | null };

function SourceReferences({ ids, sources, onChange }: { ids: string[]; sources: Map<string, DraftSource>; onChange: (ids: string[]) => void }) {
  return <span className="draft-source-selector">{[...sources.values()].map((source) => <span className="draft-source-option" key={source.id}><label title={`Use ${source.publisher}: ${source.title}`}><input type="checkbox" aria-label={`Use source ${source.id.replace('source-', '')}, ${source.publisher}: ${source.title}`} checked={ids.includes(source.id)} onChange={(event) => onChange(event.target.checked ? [...new Set([...ids, source.id])] : ids.filter((id) => id !== source.id))} /><span>{source.id.replace('source-', '')}</span></label><a href={source.url} target="_blank" rel="noopener noreferrer" title={`${source.publisher}: ${source.title}`}>{source.publisher}</a></span>)}</span>;
}

function SourcedFields({ label, items, sources, onChange, optional = false }: { label: string; items: SourcedDraftText[]; sources: Map<string, DraftSource>; onChange: (items: SourcedDraftText[]) => void; optional?: boolean }) {
  return <fieldset className="draft-fieldset"><legend>{label}</legend>{items.map((item, index) => <div className="draft-sourced-field" key={`${label}-${index}`}>
    <textarea aria-label={`${label}, item ${index + 1}`} value={item.text} onChange={(event) => onChange(items.map((current, currentIndex) => currentIndex === index ? { ...current, text: event.target.value } : current))} rows={3} />
    <div><span>Supporting sources</span><SourceReferences ids={item.source_ids} sources={sources} onChange={(source_ids) => onChange(items.map((current, currentIndex) => currentIndex === index ? { ...current, source_ids } : current))} /></div>
    {optional ? <button className="admin-secondary-button" type="button" onClick={() => onChange(items.filter((_, currentIndex) => currentIndex !== index))}>Remove point {index + 1}</button> : null}
  </div>)}{optional ? <><p className="draft-section-note">Optional: include only distinct, source-backed uncertainties. Keep essential caveats beside the relevant claims in the core copy.</p>{items.length < 3 ? <button className="admin-secondary-button" type="button" onClick={() => onChange([...items, { text: '', source_ids: [] }])}>Add uncertainty</button> : null}</> : null}</fieldset>;
}

function SingleSourcedField({ label, item, sources, onChange }: { label: string; item: SourcedDraftText; sources: Map<string, DraftSource>; onChange: (item: SourcedDraftText) => void }) {
  return <SourcedFields label={label} items={[item]} sources={sources} onChange={(items) => items[0] && onChange(items[0])} />;
}

type DraftEditorProps = {
  storyId: string;
  initialContent: StoryDraftContent;
  sourceList: DraftSource[];
  updatedAt: string;
  coursePromotion?: TrainingCoursePromotion | null;
  readOnly?: boolean;
  saveEndpoint?: string;
  editorLabel?: string;
  editorTitle?: string;
  editorDescription?: string;
  saveLabel?: string;
  savedMessage?: string;
  previewLabel?: string;
  previewStatus?: string;
  allowCoverageRecalculation?: boolean;
};

export function DraftEditor({
  storyId,
  initialContent,
  sourceList,
  updatedAt,
  coursePromotion,
  readOnly = false,
  saveEndpoint = `/api/admin/drafts/${storyId}`,
  editorLabel = 'The shared article template',
  editorTitle = 'Review the generated copy',
  editorDescription = 'These fields map directly to the public article design. Source numbers remain attached in the editor while you check each factual claim.',
  saveLabel = 'Save draft',
  savedMessage = 'Draft saved. Its automatic publishing slot has been checked.',
  previewLabel,
  previewStatus,
  allowCoverageRecalculation = true,
}: DraftEditorProps) {
  const router = useRouter();
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [searchingImages, setSearchingImages] = useState(false);
  const [imageCandidates, setImageCandidates] = useState<UnsplashImageCandidate[]>([]);
  const [imageMessage, setImageMessage] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const sources = useMemo(() => new Map(sourceList.map((source) => [source.id, source])), [sourceList]);

  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setFailed(false);
    try {
      const response = await fetch(saveEndpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
      const result = await response.json() as { saved?: boolean; queueWarning?: string; error?: string };
      if (!response.ok || !result.saved) {
        setFailed(true);
        setMessage(result.error ?? 'The draft could not be saved.');
      } else {
        setMessage(result.queueWarning ? `Draft saved, but ${result.queueWarning}` : savedMessage);
        router.refresh();
      }
    } catch {
      setFailed(true);
      setMessage('The draft could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  const setCoverage = (key: keyof DraftCoverageAnalysis, value: string) => {
    setContent((current) => ({ ...current, coverage_analysis: { ...current.coverage_analysis, [key]: Math.max(0, Math.min(100, Number(value) || 0)) } }));
  };

  async function recalculateCoverage() {
    setRecalculating(true);
    setMessage('');
    setFailed(false);
    try {
      const response = await fetch(`/api/admin/drafts/${storyId}/coverage`, { method: 'POST' });
      const result = await response.json() as { coverage?: DraftCoverageAnalysis; estimatedCostUsd?: number; error?: string };
      if (!response.ok || !result.coverage) {
        setFailed(true);
        setMessage(result.error ?? 'Coverage analysis could not be recalculated.');
      } else {
        setContent((current) => ({ ...current, coverage_analysis: result.coverage! }));
        setMessage(`Coverage recalculated from the research pack. Estimated model cost $${Number(result.estimatedCostUsd ?? 0).toFixed(4)}.`);
        router.refresh();
      }
    } catch {
      setFailed(true);
      setMessage('Coverage analysis could not be recalculated.');
    } finally {
      setRecalculating(false);
    }
  }

  async function searchImages() {
    const query = content.image_search_query.trim();
    if (query.length < 2) {
      setImageMessage('Enter a more specific image search.');
      return;
    }
    setSearchingImages(true);
    setImageMessage('');
    try {
      const response = await fetch(`/api/admin/images/unsplash?query=${encodeURIComponent(query)}`);
      const result = await response.json() as { images?: UnsplashImageCandidate[]; error?: string };
      if (!response.ok) {
        setImageCandidates([]);
        setImageMessage(result.error ?? 'Images could not be found.');
      } else {
        setImageCandidates(result.images ?? []);
        setImageMessage(result.images?.length ? 'Choose an image below. It will remain private until the article is published.' : 'No suitable images were found. Try a broader habitat or species search.');
      }
    } catch {
      setImageCandidates([]);
      setImageMessage('Images could not be found.');
    } finally {
      setSearchingImages(false);
    }
  }

  function selectImage(candidate: UnsplashImageCandidate) {
    setContent((current) => ({
      ...current,
      image_url: candidate.image_url,
      image_alt: candidate.alt_text || candidate.description || current.image_search_query,
      image_credit: candidate.credit,
    }));
    setImageCandidates([]);
    setImageMessage(`Selected a photograph by ${candidate.credit.creator_name}. Save the draft to keep this choice.`);
  }

  const blankManualCredit = (): EditorialImageCredit => ({
    provider: 'manual', source_id: '', creator_name: '', creator_url: '', source_name: '', source_url: '', licence_name: '', licence_url: '', download_location: '', illustrative: false,
  });

  function updateManualCredit(changes: Partial<EditorialImageCredit>) {
    setContent((current) => ({ ...current, image_credit: { ...(current.image_credit?.provider === 'manual' ? current.image_credit : blankManualCredit()), ...changes, provider: 'manual' } }));
  }

  function toggleTopic(topic: string) {
    setContent((current) => {
      const selected = current.topics.includes(topic)
        ? current.topics.filter((item) => item !== topic)
        : current.topics.length < 3 ? [...current.topics, topic] : current.topics;
      return { ...current, topics: selected };
    });
  }

  const article: ArticleTemplateData = {
    templateVersion: content.template_version,
    topics: content.topics,
    headline: content.headline,
    storyAtAGlance: content.story_at_a_glance.map((item) => ({ text: item.text, sourceIds: item.source_ids })),
    imageUrl: content.image_url,
    imageAlt: content.image_alt,
    imageCredit: content.image_credit,
    updatedAt,
    keyTakeaways: content.key_takeaways.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    whyItMatters: { text: content.why_it_matters.text, sourceIds: content.why_it_matters.source_ids, links: content.why_it_matters.links },
    whatHappensNext: { text: content.what_happens_next.text, sourceIds: content.what_happens_next.source_ids, links: content.what_happens_next.links },
    whatWeKnow: content.what_we_know.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    whatWeDontKnow: content.what_we_dont_know.map((item) => ({ text: item.text, sourceIds: item.source_ids, links: item.links })),
    sources: sourceList.map((source, index) => ({ id: source.id, name: source.publisher, title: source.title, url: source.url, primary: index === 0 || source.source_type === 'primary' })),
    coverage: {
      ecological: content.coverage_analysis.ecological,
      evidence: content.coverage_analysis.evidence,
      consensus: content.coverage_analysis.consensus,
    },
    coursePromotion,
  };
  const coverageLooksUncalibrated = [content.coverage_analysis.ecological, content.coverage_analysis.evidence, content.coverage_analysis.consensus].every((score) => score <= 1);

  return <>
    <form className={`draft-editor${readOnly ? ' draft-editor-readonly' : ''}`} onSubmit={save}>
      <fieldset disabled={readOnly} className="draft-editor-lock">
      <div className="draft-editor-heading"><div><p className="eyebrow">{editorLabel}</p><h2>{editorTitle}</h2><p>{editorDescription}</p></div><button className="admin-primary-button" type="submit" disabled={saving}>{saving ? <><LoaderCircle className="admin-spinner" /> Saving</> : <><Save /> {saveLabel}</>}</button></div>
      {message ? <output className={failed ? 'draft-save-message failed' : 'draft-save-message'}>{failed ? null : <Check />}{message}</output> : null}

      <section className="draft-edit-section"><h3>Article identity</h3>
        <fieldset className="draft-topic-selector"><legend>Topics — choose a primary topic first, then up to two additional topics</legend><div>{EDITORIAL_TOPICS.map((topic) => <label key={topic}><input type="checkbox" checked={content.topics.includes(topic)} disabled={!content.topics.includes(topic) && content.topics.length >= 3} onChange={() => toggleTopic(topic)} /><span>{topic}</span>{content.topics[0] === topic ? <small>Primary</small> : null}</label>)}</div>{!content.topics.length ? <p>At least one controlled topic is required before this article can be published.</p> : null}</fieldset>
        <label><span>Headline</span><input value={content.headline} onChange={(event) => setContent({ ...content, headline: event.target.value })} maxLength={180} required /></label>
        <label><span>Standfirst for listings and search</span><textarea value={content.standfirst} onChange={(event) => setContent({ ...content, standfirst: event.target.value })} rows={3} maxLength={400} required /></label>
      </section>

      <section className="draft-edit-section draft-image-section">
        <div className="draft-section-heading"><div><h3>Featured image</h3><p className="draft-section-note">Unsplash images are automatically labelled as illustrative and credited to the photographer.</p></div>{content.image_url ? <button className="admin-secondary-button" type="button" onClick={() => setContent((current) => ({ ...current, image_url: '', image_alt: '', image_credit: null }))}><X /> Remove image</button> : null}</div>
        {content.image_url ? <div className="draft-selected-image">{/* oxlint-disable-next-line next/no-img-element */}<img src={content.image_url} alt={content.image_alt} /><div><strong>{content.image_credit?.illustrative ? 'Illustrative image' : 'Featured image'}</strong>{content.image_credit ? <p>Photo by {content.image_credit.creator_name || 'Unknown creator'}{content.image_credit.source_name ? ` on ${content.image_credit.source_name}` : ''} · {content.image_credit.licence_name || 'Licence details required'}</p> : <p>Manual image — check that attribution and reuse permission are recorded below.</p>}</div></div> : <div className="draft-image-empty"><ImageIcon /><div><strong>No featured image selected</strong><p>Search Unsplash to add a free, credited illustrative image.</p></div></div>}
        <div className="draft-image-search"><label><span>Unsplash search</span><input value={content.image_search_query} onChange={(event) => setContent({ ...content, image_search_query: event.target.value })} maxLength={120} placeholder="For example: white rhinoceros grassland" /></label><button className="admin-secondary-button" type="button" onClick={searchImages} disabled={searchingImages}>{searchingImages ? <><LoaderCircle className="admin-spinner" /> Searching</> : <><Search /> Find images</>}</button></div>
        {imageMessage ? <p className="draft-image-message">{imageMessage}</p> : null}
        {imageCandidates.length ? <div className="draft-image-results">{imageCandidates.map((candidate) => <button type="button" onClick={() => selectImage(candidate)} key={candidate.id}>{/* oxlint-disable-next-line next/no-img-element */}<img src={candidate.thumbnail_url} alt={candidate.alt_text} /><span><strong>Use this image</strong><small>{candidate.credit.creator_name} · Unsplash</small></span></button>)}</div> : null}
        <label><span>Alternative text</span><input value={content.image_alt} onChange={(event) => setContent({ ...content, image_alt: event.target.value })} maxLength={300} placeholder="Describe what is visibly shown in the image" /></label>
        <details className="draft-manual-image"><summary>Use your own image or URL</summary><div>
          <label><span>Direct image URL</span><input type="url" value={content.image_url} onChange={(event) => { const image_url = event.target.value; setContent((current) => ({ ...current, image_url, image_credit: image_url && current.image_credit?.provider === 'unsplash' ? blankManualCredit() : current.image_credit })); }} placeholder="https://…" /></label>
          <label><span>Photographer or creator</span><input value={content.image_credit?.creator_name ?? ''} onChange={(event) => updateManualCredit({ creator_name: event.target.value })} maxLength={200} /></label>
          <label><span>Creator profile or website</span><input type="url" value={content.image_credit?.creator_url ?? ''} onChange={(event) => updateManualCredit({ creator_url: event.target.value })} /></label>
          <label><span>Image source</span><input value={content.image_credit?.source_name ?? ''} onChange={(event) => updateManualCredit({ source_name: event.target.value })} maxLength={120} placeholder="For example: WildTeam media library" /></label>
          <label><span>Source URL</span><input type="url" value={content.image_credit?.source_url ?? ''} onChange={(event) => updateManualCredit({ source_url: event.target.value })} /></label>
          <label><span>Licence or permission</span><input value={content.image_credit?.licence_name ?? ''} onChange={(event) => updateManualCredit({ licence_name: event.target.value })} maxLength={120} placeholder="For example: CC BY 4.0 or used with permission" /></label>
          <label><span>Licence URL</span><input type="url" value={content.image_credit?.licence_url ?? ''} onChange={(event) => updateManualCredit({ licence_url: event.target.value })} /></label>
          <label className="draft-image-checkbox"><input type="checkbox" checked={content.image_credit?.illustrative ?? false} onChange={(event) => updateManualCredit({ illustrative: event.target.checked })} /><span>Label this as an illustrative image</span></label>
        </div></details>
      </section>

      <section className="draft-edit-section"><h3>Article copy</h3>
        <SourcedFields label="The story at a glance — two paragraphs" items={content.story_at_a_glance} sources={sources} onChange={(story_at_a_glance) => setContent({ ...content, story_at_a_glance })} />
        <SourcedFields label="What you need to know — five points" items={content.key_takeaways} sources={sources} onChange={(key_takeaways) => setContent({ ...content, key_takeaways })} />
        <SingleSourcedField label="Why this matters" item={content.why_it_matters} sources={sources} onChange={(why_it_matters) => setContent({ ...content, why_it_matters })} />
        <SingleSourcedField label="What happens next" item={content.what_happens_next} sources={sources} onChange={(what_happens_next) => setContent({ ...content, what_happens_next })} />
        {content.template_version !== 3 ? <SourcedFields label="What we know" items={content.what_we_know} sources={sources} onChange={(what_we_know) => setContent({ ...content, what_we_know })} /> : null}
        <SourcedFields label={content.template_version === 3 ? "What's still unclear" : "What we don't know"} optional={content.template_version === 3} items={content.what_we_dont_know} sources={sources} onChange={(what_we_dont_know) => setContent({ ...content, what_we_dont_know })} />
      </section>

      <section className="draft-edit-section"><div className="draft-section-heading"><div><h3>Coverage analysis</h3><p className="draft-section-note">These calibrated scores power both coverage panels in the article.</p></div>{allowCoverageRecalculation ? <button className="admin-secondary-button" type="button" onClick={recalculateCoverage} disabled={recalculating}>{recalculating ? <><LoaderCircle className="admin-spinner" /> Recalculating</> : <><RotateCcw /> Recalculate coverage</>}</button> : null}</div><div className="draft-score-fields">
        {coverageLooksUncalibrated ? <p className="draft-coverage-warning">These scores came from the earlier decimal-conversion bug. Use “Recalculate coverage” before publishing.</p> : null}
        <label><span>Ecological</span><input type="number" min="0" max="100" value={content.coverage_analysis.ecological} onChange={(event) => setCoverage('ecological', event.target.value)} /></label>
        <label><span>Evidence-led</span><input type="number" min="0" max="100" value={content.coverage_analysis.evidence} onChange={(event) => setCoverage('evidence', event.target.value)} /></label>
        <label><span>Consensus</span><input type="number" min="0" max="100" value={content.coverage_analysis.consensus} onChange={(event) => setCoverage('consensus', event.target.value)} /></label>
      </div></section>

      <section className="draft-edit-section"><h3>Search preview</h3><label><span>SEO title</span><input value={content.seo_title} onChange={(event) => setContent({ ...content, seo_title: event.target.value })} maxLength={180} /></label><label><span>SEO description</span><textarea value={content.seo_description} onChange={(event) => setContent({ ...content, seo_description: event.target.value })} rows={3} maxLength={320} /></label></section>
      </fieldset>
    </form>

    <section className="draft-template-preview" aria-label={previewLabel ?? (readOnly ? 'Published article preview' : 'Private article preview')}>
      <div className="draft-preview-banner"><ShieldCheck /><span>{previewLabel ?? (readOnly ? 'Published article using the live article template' : 'Private preview using the live article template')}</span><strong>{previewStatus ?? (readOnly ? 'Live' : 'Not published')}</strong></div>
      <ArticleTemplate article={article} />
    </section>
  </>;
}
