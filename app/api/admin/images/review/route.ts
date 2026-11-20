import { requireApiAdmin } from '@/lib/supabase/require-api-admin';
import { reviewEditorialImage } from '@/lib/images/image-safety';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireApiAdmin();
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.image_url !== 'string' || body.image_url.length > 2000) return Response.json({ error: 'A valid image URL is required.' }, { status: 400 });
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 1000) : '';
  try {
    const review = await reviewEditorialImage({ image_url: body.image_url, alt_text: text(body.alt_text), source_url: text(body.source_url), subject: text(body.subject) });
    return Response.json({ review }, { status: review.status === 'approved' ? 200 : 422, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Image safety could not be verified. Choose another image or retry.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
