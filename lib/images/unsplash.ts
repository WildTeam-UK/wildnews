import type { UnsplashImageCandidate } from './types';
import { environmentValue } from '@/lib/environment';
import { reviewEditorialImage } from './image-safety';
import { imageWeaponReason } from './image-policy';

const API_URL = 'https://api.unsplash.com';
const REQUEST_TIMEOUT_MS = 10_000;
const APP_NAME = 'wildnews';

type UnsplashPhoto = {
  id: string;
  width: number;
  height: number;
  description: string | null;
  alt_description: string | null;
  urls: { raw: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
};

function accessKey() {
  return environmentValue(process.env.UNSPLASH_ACCESS_KEY);
}

function withAttributionTracking(value: string) {
  const url = new URL(value);
  url.searchParams.set('utm_source', APP_NAME);
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}

function imageUrl(value: string, width: number, height: number) {
  const url = new URL(value);
  url.searchParams.set('auto', 'format');
  url.searchParams.set('fit', 'crop');
  url.searchParams.set('crop', 'entropy');
  url.searchParams.set('w', String(width));
  url.searchParams.set('h', String(height));
  url.searchParams.set('q', '85');
  return url.toString();
}

function toCandidate(photo: UnsplashPhoto): UnsplashImageCandidate {
  return {
    id: photo.id,
    image_url: imageUrl(photo.urls.raw, 1800, 1000),
    thumbnail_url: imageUrl(photo.urls.raw, 640, 400),
    alt_text: (photo.alt_description ?? photo.description ?? '').trim(),
    description: (photo.description ?? photo.alt_description ?? '').trim(),
    width: photo.width,
    height: photo.height,
    credit: {
      provider: 'unsplash',
      source_id: photo.id,
      creator_name: photo.user.name,
      creator_url: withAttributionTracking(photo.user.links.html),
      source_name: 'Unsplash',
      source_url: withAttributionTracking(photo.links.html),
      licence_name: 'Unsplash License',
      licence_url: 'https://unsplash.com/license',
      download_location: photo.links.download_location,
      illustrative: true,
    },
  };
}

export function unsplashIsConfigured() {
  return Boolean(accessKey());
}

export async function searchUnsplashImages(query: string, limit = 6): Promise<UnsplashImageCandidate[]> {
  const key = accessKey();
  if (!key) throw new Error('Unsplash has not been connected yet.');
  const url = new URL(`${API_URL}/search/photos`);
  url.searchParams.set('query', query.trim());
  url.searchParams.set('orientation', 'landscape');
  url.searchParams.set('content_filter', 'high');
  url.searchParams.set('per_page', String(Math.max(1, Math.min(12, limit * 3))));
  const response = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = response.status === 401 ? 'Check the Unsplash access key.' : `Unsplash returned ${response.status}.`;
    throw new Error(`Image search failed. ${detail}`);
  }
  const result = await response.json() as { results?: UnsplashPhoto[] };
  const safe: UnsplashImageCandidate[] = [];
  const signal = AbortSignal.timeout(25_000);
  for (const candidate of (result.results ?? []).map(toCandidate)) {
    if (safe.length >= Math.max(1, Math.min(6, limit))) break;
    if (imageWeaponReason([candidate.image_url, candidate.alt_text, candidate.description, candidate.credit.source_url])) continue;
    const review = await reviewEditorialImage({ image_url: candidate.image_url, alt_text: candidate.alt_text, description: candidate.description, source_url: candidate.credit.source_url, subject: query }, signal);
    if (review.status === 'approved') safe.push(candidate);
  }
  return safe;
}

export async function recordUnsplashSelection(downloadLocation: string) {
  const key = accessKey();
  if (!key || !downloadLocation) return;
  const url = new URL(downloadLocation);
  if (url.origin !== API_URL) return;
  const response = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) console.warn(`Unsplash selection tracking returned ${response.status}.`);
}
