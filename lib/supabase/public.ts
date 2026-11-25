import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getPublicSupabaseConfig } from './config';
import { operationalLog } from '@/lib/operational-log';
import { publicDatabaseReadSignal } from '@/lib/public-read-budget';

let publicClient: SupabaseClient | undefined;

export function getSupabasePublicClient() {
  if (!publicClient) {
    const { url, publishableKey } = getPublicSupabaseConfig();
    publicClient = createClient(url, publishableKey, {
      // The SDK otherwise retries beneath our fetch timeout, resetting the
      // six-second deadline for each attempt and multiplying origin load.
      db: { retry: false },
      global: {
        fetch: async (input, init) => {
          const started = Date.now();
          const signal = publicDatabaseReadSignal(init?.signal);
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
