import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DigestTemplate } from '@/components/digest-template';
import { InteriorHeader } from '@/components/interior-header';
import { JsonLd } from '@/components/json-ld';
import { SiteFooter } from '@/components/site-footer';
import { cleanDigestText, digestPath, getPublishedDailyDigests, getPublishedDigest, type DigestContent, type DigestType } from '@/lib/digests';
import { articleMetadata, newsArticleJsonLd, withSiteName } from '@/lib/seo';
import { operationalLog } from '@/lib/operational-log';

export async function publishedDigestMetadata(type: DigestType, date: string): Promise<Metadata> {
  const digest = await getPublishedDigest(type, date);
  const edition = type === 'weekly' ? 'Weekly' : 'Daily';
  if (!digest) return { title: `${edition} digest not found | WILDNEWS`, robots: { index: false, follow: false } };

  const content = digest.generation_metadata.digest_content;
  const title = withSiteName(cleanDigestText(content?.seo_title ?? digest.headline));
  const description = cleanDigestText(content?.seo_description ?? digest.standfirst);
  return articleMetadata({
    title,
    description,
    path: digestPath(type, date),
    image: digest.image_url,
    imageAlt: digest.image_alt,
    publishedTime: digest.published_at,
    modifiedTime: digest.updated_at,
  });
}

export async function PublishedDigestPage({ type, date }: { type: DigestType; date: string }) {
  const [digest, moreDigests] = await Promise.all([
    getPublishedDigest(type, date),
    type === 'daily' ? getPublishedDailyDigests(7).catch((error: unknown) => { operationalLog('error', { operation: 'digest_optional_related' }, error); return undefined; }) : Promise.resolve(undefined),
  ]);
  const content = digest?.generation_metadata.digest_content as DigestContent | undefined;
  if (!digest || !content) notFound();

  const path = digestPath(type, date);
  const structuredData = newsArticleJsonLd({
    headline: digest.headline,
    description: digest.standfirst,
    path,
    image: digest.image_url,
    publishedTime: digest.published_at,
    modifiedTime: digest.updated_at,
    sections: content.topics,
  });

  return <main>
    <InteriorHeader />
    <JsonLd data={structuredData} />
    <DigestTemplate
      content={content}
      stories={digest.generation_metadata.digest_source_stories ?? []}
      storyId={digest.id}
      periodEnd={digest.digest_period_end}
      imageUrl={digest.image_url}
      imageAlt={digest.image_alt}
      moreDigests={moreDigests}
      sharePath={path}
    />
    <SiteFooter />
  </main>;
}
