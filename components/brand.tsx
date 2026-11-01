/* oxlint-disable next/no-html-link-for-pages -- a full page load keeps home navigation reliable in Vinext */

import { BrandWordmark } from '@wildteam-uk/ui';

export function Brand() {
  return (
    <a href="/" className="brand" aria-label="WildTeam News home">
      <span className="brand-mark" aria-hidden="true" />
      <BrandWordmark
        className="brand-wordmark"
        product="TEAM"
        aria-hidden="true"
      />
    </a>
  );
}
