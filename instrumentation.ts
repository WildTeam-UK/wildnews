import { operationalLog } from './lib/operational-log';

export function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath: string; routeType: string },
) {
  const digest = error && typeof error === 'object' && 'digest' in error ? String(error.digest).slice(0, 80) : undefined;
  const requestId = request.headers['x-vercel-id'];
  operationalLog('error', {
    operation: `request_${context.routeType}`,
    route: context.routePath,
    method: request.method,
    requestId: typeof requestId === 'string' ? requestId.slice(0, 160) : undefined,
    digest,
  }, error);
}
