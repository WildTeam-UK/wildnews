export const EDITORIAL_STEP_LEASE_SECONDS = 300;
export const EDITORIAL_STEP_RENEWAL_MS = 30_000;

export class EditorialStepLeaseLost extends Error {
  constructor() { super('The editorial step lease expired or was replaced. The current worker must stop.'); }
}

// Renew slow AI steps while this request is alive. A suspended or terminated
// worker still expires, and cannot write run progress after a replacement starts.
export function maintainEditorialStepLease(renew: () => Promise<boolean>, intervalMs = EDITORIAL_STEP_RENEWAL_MS) {
  let lost = false;
  let stopped = false;
  let pending: Promise<void> | null = null;
  const assertActive = async () => {
    if (lost || stopped) throw new EditorialStepLeaseLost();
    if (!pending) {
      pending = (async () => {
        try { if (!await renew()) lost = true; }
        catch { lost = true; }
      })().finally(() => { pending = null; });
    }
    await pending;
    if (lost || stopped) throw new EditorialStepLeaseLost();
  };
  const timer = setInterval(() => { void assertActive().catch(() => {}); }, intervalMs);
  timer.unref();
  return {
    assertActive,
    stop: async () => { stopped = true; clearInterval(timer); await pending; },
  };
}
