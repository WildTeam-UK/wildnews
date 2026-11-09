# WildNews design system

This document records the design currently implemented by WildNews. It is descriptive, not a redesign brief. When the code and this document disagree, inspect the live component and effective CSS cascade before changing either.

## Foundations

### Colour tokens

The canonical ecosystem values come from `@wildteam-uk/tokens`. `app/globals.css` maps WildNews's established local names to those shared `--wt-*` custom properties so existing editorial components keep their current API and layout. WildNews-only semantic and workflow colours remain local.

| Token | Value | Implemented use |
| --- | --- | --- |
| `--ink` | `#080808` | Primary text, strong rules and dark surfaces |
| `--brand-purple` | `#6e0f6c` | WildTeam purple, headings, links and primary hover states |
| `--brand-gradient-middle` | `#b41e8e` | Middle stop in branded gradient treatments |
| `--brand-pink` | `#e60088` | WildTeam pink, primary actions, accents and focus states |
| `--cream` | `#fef3e5` | Warm neutral panels, topic pills and supporting surfaces |
| `--paper` | `#ffffff` | Page and card surfaces |
| `--rule` | `#d6d1d3` | Standard dividers and quiet borders |
| `--muted` | `#5d5d61` | Secondary copy, dates and metadata |
| `--surface-charcoal` | `#262626` | Shared charcoal surface for digest heroes, full-width training promotions and the WildTeam footer |
| `--footer-muted` | `#f5f5f5` | Secondary footer links and legal copy |
| `--text-on-purple-muted` / `--text-on-charcoal-muted` | `#eadbea` / `#d9d5d7` | Supporting copy on the two dark CTA surfaces |
| `--text-placeholder` | `#777378` | Form placeholder copy |
| `--accent-coral` | `#e84a43` | Contested coverage signal |
| `--accent-orange` | `#ff8044` | Economic coverage signal, warning progress and retained accent treatments |
| `--signal-neutral-track` / `--signal-neutral-fill` | `#ddd` / `#8f8f8f` | Neutral coverage-analysis tracks and values |
| `--status-success-text` / `--status-success-surface` | `#17602d` / `#e7f5e9` | Successful admin states and confirmation messages |
| `--status-warning-text` | `#9a4917` | Warning icons and copy |
| `--status-error-text` / `--status-error-surface` | `#8a1d24` / `#fff0f0` | Standard destructive and failed states |
| `--status-error-strong` | `#7b1820` | Higher-emphasis error copy |
| `--status-info-text` / `--status-info-surface` | `#18517c` / `#e8f4ff` | Informational, generated and scheduled states |
| `--status-pending-text` / `--status-pending-surface` | `#875109` / `#fff1d9` | Work that is actively publishing or awaiting completion |
| `--status-partial-text` / `--status-partial-surface` | `#785514` / `#fff4d7` | Partial workflow outcomes |

Less frequently repeated state shades remain local to the component that owns them. Course promotions use a course-specific `--course-colour` supplied by the database.

The Good News and digest “fancy” labels use a gradient made from `#6e0f6c`, `#b41e8e` and `#e60088`. Their hover state is solid pink with white text.

### Typography

The application uses **VAG Rounded** throughout. Local files live under `public/fonts`:

- Light: `vag-rounded-light.woff2`, weights 300–500
- Bold: `vag-rounded-bold.woff`, weights 501–800
- Black: `vag-rounded-black.woff`, weights 801–950

`--font-family` is the single application font-family token. All public, editorial and admin interfaces use it with a sans-serif fallback; there is no secondary UI family or active serif typeface.

The three installed faces are exposed through semantic weight tokens rather than treating every numeric value as a different design choice:

| Token | Value | Role |
| --- | --- | --- |
| `--font-weight-regular` | `400` | Body copy and normal controls |
| `--font-weight-bold` | `800` | Eyebrows, captions and supporting emphasis |
| `--font-weight-black` | `900` | Display headings, card titles, actions and strong labels |

The shared public typography roles are:

| Role | Tokens | Current treatment |
| --- | --- | --- |
| Caption | `--type-caption-size`, `--type-caption-leading` | 10px / 1.35; used by editorial image credits |
| Label | `--type-label-size`, `--type-label-leading`, `--type-label-tracking` | 11px / 1 / `.1em`; used by the standard eyebrow |
| Small body | `--type-body-small-size`, `--type-body-small-leading` | 15px / 1.55; used by supporting CTA copy |
| Editorial body | `--type-body-size`, `--type-body-leading` | 17px / 1.65; sections may retain a deliberately roomier local leading |
| Editorial lead | `--type-lead-size`, `--type-lead-leading` | 21px / 1.72; used by digest introductions |
| Card title | `--type-card-title-size`, `--type-card-title-leading` | 25px / 1.08; used by related and digest discovery cards |
| Supporting panel title | `--type-supporting-panel-title-size` | 27px; aligns coverage, course and newsletter headings beneath mobile articles |
| Section title | `--type-section-title-size`, `--type-section-title-leading` | 44px / 1; used by principal editorial sections |

Components own their layout, colour and responsive variation while consuming these shared roles. A one-off display size may remain local when it expresses a genuinely different hierarchy; new near-duplicate values should not be introduced without updating this system.

Implemented hierarchy:

- Public body default: 18px.
- Editorial body copy: normally 16–18px with 1.5–1.78 line height.
- Article and digest introductions: about 18px on small screens and 21px on larger screens.
- Labels, dates, eyebrows and metadata: usually 8–12px, bold or black, uppercase, with positive letter spacing.
- Card titles: commonly 21–25px.
- Section headings: commonly 36–44px, depending on context and viewport.
- Feature and archive titles: responsive `clamp()` sizes, normally around 48–96px.
- Article hero titles: `clamp(40px, 5.5vw, 72px)` with a 1.02 line height. Their maximum width shares the 900px article-overview measure through `--article-reading-width`.
- Display headings use tight line height and negative letter spacing. Body copy uses normal tracking.

The `WILDNEWS` wordmark uses weight 950, tight tracking and separate purple `WILD` and pink `NEWS` spans. Inline branding follows this treatment except inside the digest hero, newsletter CTAs and training banner, where it inherits the surrounding typography and colour.

### Layout and spacing

- Standard public shell: `min(1240px, 100% - 48px)` and horizontally centred.
- Phone shell gutter: 15px on each side (`100% - 30px`).
- The primary editorial reading column is approximately 760px.
- Digest editorial images may expand to approximately 920px while remaining centred on the reading column.
- Public sections generally use generous vertical spacing, commonly 52–110px.
- Component gaps commonly use 7–12px for compact controls, 20–32px for cards, and 50–90px for major grids.

The main public grids are:

- Homepage hero: asymmetric two-column layout with equal outer spacing above and below on side-by-side layouts. On tablet and desktop, the image occupies one third of the grid and stretches from the top of the topic row to the bottom of the action button, while the copy occupies and may use the full remaining two-thirds column. A compact responsive gutter of `clamp(16px, 2.5vw, 36px)` separates the image and copy. At 820px and below, the image remains first and the full-width story copy stacks underneath it. The stacked layout uses 18px above the image, 18px between the image and copy, and 64px below the action button before a standard grey divider; the following latest-stories section begins 28px after that divider. The linked title uses the same font-relative underline hover cue as large archive titles; smaller card titles retain their finer underline treatment.
- Latest stories: primary list plus compact secondary column.
- Standard listings: two-column card grid on desktop.
- Topic shelves: horizontal snap-scrolling card tracks.
- Article body: main editorial column plus sticky analysis/training sidebar.
- Digest hero: 50/50 copy and image.
- Archive lead: one featured story followed by standard story cards.
- Related or “more” stories: three-column discovery grid.

### Responsive tiers

The stylesheet contains feature-specific breakpoints. The principal behavioural tiers are:

- Above 920px: full desktop admin navigation.
- 821px and above: desktop public navigation and multi-column public layouts.
- 900–1120px: tablet adjustments for selected admin, digest and card layouts.
- 820px and below: public navigation becomes a hamburger menu; major grids stack.
- 600px and below: digest-specific phone treatment.
- 560px and below: compact public typography, 15px gutters and phone card layouts.
- 520px and below: selected admin controls stack fully.

Do not introduce another breakpoint without confirming that an existing tier cannot express the required behaviour.

## Shape, borders and depth

- Compact controls use `--radius-control` at 9px and compact surfaces use `--radius-compact` at 10px.
- Standard cards and large panels use the shared 18px radius through `--radius-card` and `--radius-panel`.
- Pill shapes use the shared 18px `--radius-pill`; genuinely circular controls use `--radius-round`.
- Public button radius: 6px.
- Image and standard card radii are 18px where the shared card token is used.
- Some feature-specific editorial panels retain 20px or 24px radii.
- Some feature-specific admin inputs and small controls retain 7px, 8px, 11px, 12px or 14px radii.
- Pills use 18px; circular controls use 50%.
- Standard dividers: 1px `--rule`.
- Strong section dividers: 3px `--ink`.
- Public components are generally flat. Repeated black offset shadows use the `--shadow-offset-sm` through `--shadow-offset-xl` scale; muted legacy cards use `--shadow-card-soft`.
- Admin cards use a quiet grey border and a scoped `3px 3px` neutral shadow.
- Image attributions use a white 99px-radius capsule, 10px muted text and a subtle shadow.

The admin surface standardises card borders and shadows through `--admin-card-border` and `--admin-card-shadow` in `app/admin-workspace.css`.

## Interaction states

- Primary public buttons: pink background, white text; purple background on hover.
- Secondary public buttons: transparent with pink border/text; purple border/text on hover.
- Shared CTA colour states are owned by the `Public CTA colour system` block in `app/globals.css`; component rules define their geometry and layout without restating those colours.
- The Good News navigation button uses the primary treatment plus a periodic shine. Reduced-motion users do not receive the animation.
- Topic pills: cream with purple text; pink with white text on hover.
- Fancy digest and Good News pills: white centre, 1px gradient border and gradient text; pink with white text on hover.
- Editorial `.text-link` actions are purple and change to brand pink on hover while retaining their underline and arrow treatment.
- Images in prominent story links use a subtle scale-up hover.
- Source-number circles use a grey border/text and change to pink on hover or focus.
- Links, buttons, form controls and disclosure summaries use a 2px pink keyboard-focus outline with a 3px offset. Components on dark surfaces may override this with a white ring, and newsletter inputs expose focus on their shared outer control.
- Animation must respect `prefers-reduced-motion`.

## Shared public components

### Navigation

`SiteNavigation` is sticky through its containing header and uses the approved WildTeam navigation from the Jobs experiment. Jobs, News, Training and About have accessible dropdowns; News has the active pink underline. The menus sit to the right before the 160px Good News action, with its brand icon and reduced-motion-aware shine. Sign-in is hidden. At 900px and below it becomes a full-width dropdown controlled by a hamburger button. How we use AI is linked under About in the footer.

`InteriorHeader` reuses the same public navigation on interior pages.

Navigation links lead directly to the canonical Jobs, News, Training and WildTeam destinations in the same tab.

### Editorial heroes

`ArchiveHero` and `PageHero` share the `editorial-hero` foundation. Both use the same shell width, vertical spacing, divider, title scale and full-width description. Archive heroes begin with a taxonomy or editorial pill and may include archive metadata; general-page heroes begin with an eyebrow. An archive description's optional trailing link uses the shared `descriptionLink` slot: it remains inline on larger screens and starts on a clean new line without leading or trailing whitespace on phones. New public informational pages should use `PageHero` rather than defining page-specific hero spacing or typography.

The closing editorial action panel used by the AI-transparency and Good News methodology pages is a borderless cream section.

The About page introduces related methodology pages through a three-column editorial guide grid. Each entry uses the established eyebrow, heading, body-copy and `text-link` patterns; it does not introduce a separate card treatment.

### Error pages

The public 404 page uses the WildTeam sloth illustration and friendly Training-site recovery copy in a centred layout. It retains the WildNews navigation, footer, typography and primary `.action-button` treatment. Runtime errors continue to use the more functional retry and homepage actions.

### Buttons

Use existing button classes or component-owned styles:

- Primary: `.read-more-button`, `.action-button` and CTA buttons.
- Secondary outline: `.site-navigation-button.secondary`.
- Compact admin actions remain component-specific but share grey borders, 8–10px radii and uppercase labels.

### Topic, tag and status labels

- `TopicTag` is the standard taxonomy link and may render as a topic pill.
- Approved discovery tags appear as small outlined pills.
- `DigestTag` represents daily or weekly editions and always links to `/digests`.
- `GoodNewsBadge` links to `/good-news-in-conservation`; image overlays collapse to a borderless icon treatment.
- Public topic, digest and expanded Good News pills use the shared `editorial-pill` structure and a consistent font weight of 900. Main topic and expanded Good News pills use 12px labels with `.05em` letter spacing. Every full pill reserves the same 1px border slot: standard topic pills keep it transparent, while fancy digest and Good News pills use it for the gradient border. Full pills use 7px by 12px internal padding and compact discovery pills use 5px by 9px, preserving their established outer dimensions. The pill itself owns flex alignment; its direct icon and label children must not stretch or establish another flex layout. The label trims the font's invisible cap-height and baseline space with `text-box`, allowing the parent to centre the visible label against the icon without positional offsets.
- Admin statuses use compact filled pills with semantic success, warning and error colours.

### Story cards

Story discovery uses a small set of repeated patterns:

- `story-card`: image and copy rows used in the main latest-stories list. The primary left-column cards clamp summaries to three lines and show an explicit read link on desktop and tablet; digest links say “Read this edition”. On phones, summaries clamp to two lines and the explicit link is hidden. The compact right-column stories remain title-led.
- `compact-story`: smaller image/title rows.
- `carousel-card`: horizontal topic-shelf cards.
- `TopicStoryShelf`: reusable homepage topic carousel containing up to 12 recent matching stories.
- `topic-story`: archive cards, with the first item promoted to `topic-story-featured`. All archive cards, including digest editions, show their descriptions. In the side-by-side layout, the featured image stretches to the full height of the adjacent content column; stacked layouts retain their defined image heights. Descriptions are clamped to three lines at every breakpoint. The copy column uses a consistent 16px title-to-description gap. Its explicit read link is aligned to the bottom of the card, with 16px of minimum separation from the preceding content. `EditorialArchiveCard` derives its action label from `digestType`, using “Read this edition” for daily and weekly digests and “Read story” for news.
- `related` / `SimilarStories`: three-card discovery section.
- `digest-more`: six most recent daily digest cards on daily digest pages.

Cards display the appropriate topic or digest label above the title. Good News is signalled on the image. Titles, images and explicit read links lead to the same canonical story URL.

Public editorial images use the shared `EditorialImage` component. If a remote image cannot be loaded, it replaces the failed asset with the local WildNews mark centred on a white surface while preserving the original image container and link. Photo credits are hidden when their corresponding image has fallen back, so attribution never describes an image that is no longer visible.

### Calls to action

- `NewsletterCta`: shared Weekly Digest signup component with `full` and `streamlined` variants. Both variants use the same headline and subscription form; the full variant adds supporting copy while the streamlined variant is the compact in-flow treatment.
- `TrainingBanner`: full-width editorial training promotion.
- `CoursePromotion`: course-specific sidebar promotion using the configured course colour.

Email controls visually combine a white input and pink action. Training and newsletter components suppress multicolour inline WILDNEWS branding so text inherits the CTA treatment.

### Footer

`SiteFooter` is the shared WildTeam footer. It uses a dark background, grouped About/Explore/Legal links, social icons, CPD mark and the WildTeam mission statement.

### Analytics consent

`AnalyticsConsent` is the shared public analytics notice. It uses the standard paper surface, quiet border, card radius and branded WILDNEWS wordmark, without a drop shadow. “Got it” uses the primary button treatment while “Opt out” is an unbordered pink text action. It stacks its actions on narrow phones and is not shown in the authenticated admin workspace. Closing the notice has the same effect as “Got it”; analytics remains enabled unless the visitor chooses “Opt out”. The “Cookie settings” control at the bottom of the footer's Legal menu reopens the same panel rather than introducing a second settings interface.

## Editorial page patterns

### News articles

The article template is shared by every published news story:

1. Centred hero with Good News/topic pills, title and compact coverage summary.
2. Full-width lead image with attribution.
3. “The story at a glance” introduction, discovery tags, update date and share controls. The controls form a vertical rail beside the introduction on desktop, then move above the discovery tags in a horizontal row at 1000px and below.
4. Structured editorial sections: what you need to know, why it matters, what happens next, source reporting and article feedback. Newly created articles use template version 3: they omit “What we know” and show an optional “What's still unclear” section only when it contains one to three useful, sourced uncertainties. Existing articles, including private and scheduled drafts, retain template version 2 and their original “What we know” and “What we don't know” sections. These use their descriptive headings without additional eyebrow labels and retain one consistent gap between sections.
5. Sticky desktop sidebar containing coverage analysis and a course promotion.
6. Newsletter CTA and related-story discovery supplied by the page route.

Inline source references are numbered circles. Contextual links may point to relevant internal stories, taxonomy pages, courses or external sources. Links are not added merely to meet a quota. Every article shows its compact, left-aligned publication line on a separate row beneath any discovery tags. Articles with applied revisions add the latest update date and disclosure action to that same row. The dates are static text; only “See what’s changed” and its arrow operate the disclosure. Its position remains fixed when the action opens the full-column cream editorial timeline containing both copy revisions and source-list additions. The timeline has no additional eyebrow label, and each entry cites the reporting responsible for that update with the same numbered source controls used in the article body. The previous large update notice is not used. The source section includes a plain full-column disclosure explaining that WildNews synthesises the original reporting and links to the AI methodology. The shared `ContentFeedback` component follows the source material on both articles and digests. It uses a rounded cream supporting panel with large icon-only controls aligned beside the question where space allows; its mobile and narrow-tablet layout keeps the copy on the left and stacks the controls on the right.

On phones, the overview flows into the article without a divider. Editorial sections use one consistent 48px gap rather than accumulated adjacent padding. Coverage dimensions, article feedback, the course-promotion headline and the following newsletter headline share the supporting-panel title size. Article-feedback copy remains on the left while its icon-only controls stack on the right. The same compact feedback arrangement is used while the desktop article and sidebar columns pass through their narrow tablet range, preventing the controls from crushing the copy before the article becomes one column. Source-reference circles are separated from prose by collapsible whitespace, so a wrapped reference group begins flush with the new line.

### Digests

Daily and weekly digests share one template:

1. Full-width split hero with a consistent charcoal copy panel, a fine slowly animated branded-gradient frame around its content and the edition's dedicated featured image. The frame becomes effectively static when reduced motion is requested.
2. Edition/date metadata, title, standfirst and AI-method link.
3. Digest and topic pills above the editorial introduction, whose opening paragraph uses an optically aligned drop cap. Sharing remains a vertical rail beside the introduction on desktop, then moves into a horizontal row above these pills at 1000px and below.
4. Flowing editorial sections with wider supporting images.
5. One compact newsletter CTA within the body.
6. Source-article list, training banner and full newsletter CTA.
7. Six recent daily digests on daily editions.

Digest prose uses the same restrained contextual-link policy as news articles. A dedicated link-editor pass runs only after the prose is final and normally seeks two to four useful links in an article or three to five in a digest without enforcing a minimum. Standard articles accept no more than two article links; longer digests accept no more than three. Both accept one topic or approved-tag link, one genuinely relevant course link and one materially useful external source link, with five links maximum. Links use complete words or natural phrases, never repeat a target, and are omitted when they would feel forced. External links open in a new tab.

Friday produces a weekly edition instead of a daily edition.

### Archives

Topic, approved-tag, Good News and digest archives use the shared `ArchiveHero` component for their label, full-width title, description and result count. Its label row normalises spacing across differently sized topic, tag, Good News and digest pills. Archives then show one featured story followed by standard listing cards. Newsletter and related-story sections sit beneath the archive results where configured.

### Methodology pages

Coverage-analysis dimensions use three equal editorial columns on desktop, separated by the standard grey rule. At the shared tablet breakpoint they stack into a single column and replace vertical dividers with the existing horizontal section rules.

## Admin workspace

The admin uses the same font and core palette with denser typography. Desktop has an expanded left navigation; mobile uses a hamburger-controlled menu. Grouped navigation sections preserve their open state when the active child belongs to that group.

The current destination uses a white surface with a pink edge marker in both the desktop sidebar and mobile drawer. Navigation labels use the charcoal surface colour, with purple reserved for the current destination. Every authenticated admin header includes a compact public-site shortcut alongside account controls; user settings live in the persistent profile control at the foot of the sidebar. Operational pages keep routine status visible at a glance and place infrequent or potentially disruptive controls inside labelled native disclosures. Disclosure summaries remain white in both collapsed and expanded states. Digest administration follows this pattern explicitly: schedule, publishing, Buffer and Brevo states appear as summary cards; configuration, manual generation, email testing and delivery diagnostics remain available in separate expandable sections; edition history uses distinct workflow and channel statuses rather than one dense metadata sentence.

Admin pages use:

- Compact uppercase labels and metadata, with a 12px minimum type size.
- White cards on a white page surface.
- Grey borders without drop shadows.
- Pink action buttons with borderless purple hover states and consistent 12px labels.
- Pill labels with sufficient horizontal padding for the 12px minimum type size.
- Disclosure panels for advanced or infrequent manual controls.
- Responsive tables, cards and stacked controls rather than shrinking desktop layouts below usability.

Consequential admin actions use the shared `AdminConfirmationProvider` dialog instead of browser-native confirmation prompts. The dialog uses a white bordered panel, branded action states and a quiet warning treatment; Cancel receives initial focus, while Escape, the close control and the backdrop all cancel safely.

The Articles workspace groups All, Published, Scheduled, Unscheduled, Held and Archived inside one compact status disclosure. Updates available remains a separate visible attention filter rather than competing with every routine status as another pill. Unscheduled article cards expose both queue and archive actions; archived cards expose restoration. The article workspace uses the same lifecycle controls for private and published articles, with explicit confirmation copy when an action removes a live URL.

The overview treats coverage revisions as attention items only when update automation is disabled, a manual revision is open, or automatic processing has exhausted its retries. The daily workflow controls expose one Article updates toggle so the recoverable manual path remains available without adding a second settings surface. Candidate quality thresholds sit with the daily workflow and ranking controls because they determine which candidates may consume research and drafting costs. The Schedule workspace controls publishing hours and the final publication safeguard, not candidate eligibility.

## Current implementation debt

These are recorded facts, not design changes:

- `app/globals.css` contains chronological layers of overrides, so an early declaration is not always the effective style.
- Some feature-specific colours remain local literals where they do not yet represent a reusable semantic role.
- The admin and public styles partly overlap in `globals.css`; admin consolidation is incomplete.
- Many feature-specific breakpoints repeat the same viewport widths.

Cleanup should consolidate these rules only after verifying that rendered desktop, tablet and mobile output remains unchanged.

