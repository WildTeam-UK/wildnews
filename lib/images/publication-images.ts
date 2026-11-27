import { imageWeaponReason } from './image-policy';
import { reviewEditorialImage } from './image-safety';
import { recordUnsplashSelection, searchUnsplashImages, unsplashIsConfigured } from '@/lib/images/unsplash';
import type { EditorialImageCredit } from './types';

export type PublicationImage = {
  image_url: string;
  image_alt: string;
  image_credit: EditorialImageCredit | null;
  query?: string;
};

const fallback: PublicationImage = {
  image_url: 'https://news.wildteam.org.uk/editorial-image-fallback.png',
  image_alt: 'WildNews editorial illustration',
  image_credit: null,
};

// One budget is shared by a digest's hero and cards. Failure to find a photo
// selects a known safe illustration instead of holding otherwise valid copy.
export async function chooseSafePublicationImage(
  candidates: PublicationImage[], queries: string[], subject: string,
  options: { signal?: AbortSignal; excludedUrls?: Set<string>; excludedSourceIds?: Set<string> } = {},
): Promise<PublicationImage> {
  const signal = options.signal ?? AbortSignal.timeout(25_000);
  const excludedUrls = new Set(options.excludedUrls);
  const groups = new Map<string, PublicationImage[]>();
  for (const candidate of candidates) {
    if (!candidate.image_url) continue;
    groups.set(candidate.image_url, [...(groups.get(candidate.image_url) ?? []), candidate]);
    if (imageWeaponReason([candidate.image_url, candidate.image_alt, candidate.image_credit?.source_url])) excludedUrls.add(candidate.image_url);
  }
  for (const [url, versions] of groups) {
    if (signal.aborted) break;
    if (excludedUrls.has(url)) continue;
    try {
      let approved = true;
      for (const image of versions) {
        const result = await reviewEditorialImage({ image_url: url, alt_text: image.image_alt, source_url: image.image_credit?.source_url, subject }, signal);
        if (result.status !== 'approved') { approved = false; break; }
      }
      if (approved) return versions[0];
    } catch { /* Unavailable or malformed reviews cannot approve this image. */ }
    excludedUrls.add(url);
  }
  if (!signal.aborted && unsplashIsConfigured()) {
    for (const query of [...new Set(queries.map(value => value.trim().slice(0, 120)).filter(Boolean))].slice(0, 3)) {
      if (signal.aborted) break;
      try {
        const image = (await searchUnsplashImages(query, 1, { signal, excludedUrls, excludedSourceIds: options.excludedSourceIds, subject }))[0];
        if (!image) continue;
        const finalReview = await reviewEditorialImage({ image_url: image.image_url, alt_text: image.alt_text, source_url: image.credit.source_url, subject }, signal);
        if (finalReview.status !== 'approved') { excludedUrls.add(image.image_url); continue; }
        try { await recordUnsplashSelection(image.credit.download_location, signal); }
        catch { console.warn('Safe publication image selected; attribution download tracking was unavailable.'); }
        return { image_url: image.image_url, image_alt: image.alt_text, image_credit: image.credit, query };
      } catch { /* Try a broader query while the shared budget remains. */ }
    }
  }
  return { ...fallback };
}
