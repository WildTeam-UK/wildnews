'use client';

/* oxlint-disable next/no-html-link-for-pages -- full page loads avoid unreliable Vinext client navigation */

import { RotateCcw } from 'lucide-react';
import { InteriorHeader } from '@/components/interior-header';
import { SiteFooter } from '@/components/site-footer';
import { useEffect } from 'react';

export default function PublicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: window.location.pathname, digest: error.digest?.slice(0, 80) }),
      keepalive: true,
    }).catch(() => {});
  }, [error]);
  return <main data-public-page-unavailable>
    <InteriorHeader />
    <section className="missing shell" role="alert">
      <p className="eyebrow">Something went wrong</p>
      <h1>We could not load this page.</h1>
      <p>This may be a temporary problem. Try loading the page again, or return to the latest conservation stories.</p>
      <div className="missing-actions">
        <button className="action-button" type="button" onClick={reset}>Try again <RotateCcw aria-hidden="true" /></button>
        <a className="action-button secondary-action-button" href="/">Go to the homepage</a>
      </div>
    </section>
    <SiteFooter />
  </main>;
}
