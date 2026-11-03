import { operationalLog } from '@/lib/operational-log';
import { publicPagePath } from '@/lib/public-page-cache';

let windowStart = 0;
let count = 0;

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 403 });
  if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); count = 0; }
  if (++count > 20) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  // Read a bounded body even when the caller omits Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 1024) { await reader.cancel(); return new Response(null, { status: 413 }); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  let value: { path?: unknown; digest?: unknown };
  try { value = JSON.parse(text + decoder.decode()); } catch { return new Response(null, { status: 400 }); }
  if (!value || typeof value.path !== 'string' || value.path.length > 512 || !value.path.startsWith('/') || value.path.startsWith('//')) return new Response(null, { status: 400 });
  const path = publicPagePath(new Request(new URL(value.path, origin)));
  if (!path || path !== value.path) return new Response(null, { status: 400 });
  const digest = typeof value.digest === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value.digest) ? value.digest : undefined;
  operationalLog('error', { operation: 'public_browser_boundary', route: path, digest });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
