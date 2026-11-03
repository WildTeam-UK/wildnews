type LogFields = {
  operation: string;
  route?: string;
  method?: string;
  requestId?: string;
  durationMs?: number;
  digest?: string;
};

// Allowlisted fields only: never serialize request headers, URLs, bodies or raw errors.
export function operationalLog(level: 'error' | 'warn', fields: LogFields, error?: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  console[level](JSON.stringify({
    event: 'wildnews_operation',
    ...fields,
    route: fields.route?.split('?')[0].slice(0, 512),
    code: code && /^[A-Z0-9_]{1,40}$/i.test(code) ? code : undefined,
    deployment: process.env.VERCEL_DEPLOYMENT_ID,
    timestamp: new Date().toISOString(),
  }));
}
