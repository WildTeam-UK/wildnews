import { AsyncLocalStorage } from 'node:async_hooks';

// Nitro and Vinext bundle server middleware and RSC code separately. A module-
// local store becomes two different contexts in the production build.
const key = Symbol.for('wildnews.public-read-budget.v1');
const registry = globalThis as typeof globalThis & { [key]?: AsyncLocalStorage<AbortSignal> };
const budget = registry[key] ??= new AsyncLocalStorage<AbortSignal>();
const PUBLIC_READ_MS = 6000;

// Metadata, the main page and later server components share one read deadline.
// Each request owns its signal; another visitor cannot cancel or reset it.
export function withPublicReadBudget<T>(work: () => T): T {
  if (budget.getStore()) return work();
  return budget.run(AbortSignal.timeout(PUBLIC_READ_MS), work);
}

export function publicDatabaseReadSignal(parent?: AbortSignal | null): AbortSignal {
  const signals = [AbortSignal.timeout(PUBLIC_READ_MS)];
  const requestBudget = budget.getStore();
  if (requestBudget) signals.push(requestBudget);
  if (parent) signals.push(parent);
  return AbortSignal.any(signals);
}
