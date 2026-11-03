import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getPublicSupabaseConfig } from './config';
import { operationalLog } from '@/lib/operational-log';

let publicClient: SupabaseClient | undefined;

export function getSupabasePublicClient() {
  if (!publicClient) {
    const { url, publishableKey } = getPublicSupabaseConfig();
    publicClient = createClient(url, publishableKey, {
      global: {
        fetch: async (input, init) => {
          const started = Date.now();
          const signal = init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(6000)])
            : AbortSignal.timeout(6000);
          try {
            const response = await fetch(input, { ...init, signal });
            if (!response.ok || Date.now() - started > 2000) {
              operationalLog(response.ok ? 'warn' : 'error', { operation: 'public_database_read', durationMs: Date.now() - started }, { code: `HTTP_${response.status}` });
            }
            return response;
          } catch (error) {
            operationalLog('error', { operation: 'public_database_read', durationMs: Date.now() - started }, error);
            throw error;
          }
        },
      },
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  }

  return publicClient;
}
