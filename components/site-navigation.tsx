/* oxlint-disable next/no-html-link-for-pages -- full page links keep Vinext navigation reliable */
'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Brand } from './brand';
import { NavigationIcon } from './navigation-icon';
import styles from './site-navigation.module.css';

const navigation = [
  {
    label: 'Jobs',
    href: 'https://jobs.wildteam.org.uk/',
    links: [
      ['Find conservation jobs', 'https://jobs.wildteam.org.uk/', 'search'],
      ['Employers', 'https://jobs.wildteam.org.uk/employers', 'users'],
      [
        'Career guides',
        'https://jobs.wildteam.org.uk/conservation-career-guides#career-guides-title',
        'compass',
      ],
      [
        'Sector guides',
        'https://jobs.wildteam.org.uk/conservation-career-guides#sector-guides-title',
        'leaf',
      ],
      ['Saved jobs', 'https://jobs.wildteam.org.uk/saved-jobs', 'heart'],
    ],
  },
  {
    label: 'News',
    href: 'https://news.wildteam.org.uk/',
    links: [
      ['Latest conservation news', 'https://news.wildteam.org.uk/', 'news'],
      [
        'Good News',
        'https://news.wildteam.org.uk/good-news-in-conservation',
        'sparkles',
      ],
      [
        'Daily and weekly digests',
        'https://news.wildteam.org.uk/digests',
        'mail',
      ],
    ],
  },
  {
    label: 'Training',
    href: 'https://training.wildteam.org.uk/',
    links: [
      [
        'Explore all courses',
        'https://training.wildteam.org.uk/courses',
        'book',
      ],
      ['Memberships', 'https://training.wildteam.org.uk/memberships', 'badge'],
      ['Bursaries', 'https://training.wildteam.org.uk/bursaries', 'gift'],
      [
        'Training for teams',
        'https://training.wildteam.org.uk/pricing-teams',
        'users',
      ],
    ],
  },
  {
    label: 'About',
    href: 'https://www.wildteam.org.uk/',
    links: [
      ['Our cause', 'https://www.wildteam.org.uk/our-cause', 'leaf'],
      ['Our team', 'https://www.wildteam.org.uk/team', 'users'],
      [
        'Our impact',
        'https://www.wildteam.org.uk/conservation-impact',
        'chart',
      ],
      [
        'Our partners',
        'https://www.wildteam.org.uk/conservation-partners',
        'handshake',
      ],
      ['Support us', 'https://www.wildteam.org.uk/donate', 'heart'],
      [
        'Get in touch',
        'https://training.wildteam.org.uk/contact-us',
        'message',
      ],
    ],
  },
] as const;

export function SiteNavigation() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const mobileButton = useRef<HTMLButtonElement>(null);
  const toggleRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const id = useId();

  function close() {
    setExpanded(null);
    setMobileOpen(false);
  }

  useEffect(() => {
    const header = root.current;
    if (!header) return;
    const updateHeight = () => {
      document.documentElement.style.setProperty(
        '--site-header-height',
        `${header.offsetHeight}px`,
      );
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(header);
    updateHeight();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (expanded) {
        toggleRefs.current[expanded]?.focus();
        setExpanded(null);
      } else if (mobileOpen) {
        setMobileOpen(false);
        mobileButton.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [expanded, mobileOpen]);

  return (
    <div
      className={styles.header}
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <div className={`shell ${styles.inner}`}>
        <Brand />
        <button
          className={styles.mobileToggle}
          ref={mobileButton}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-controls={`${id}-nav`}
          aria-expanded={mobileOpen}
          onClick={() => {
            setMobileOpen(!mobileOpen);
            setExpanded(null);
          }}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
              d={
                mobileOpen ? 'm6 6 12 12M6 18 18 6' : 'M4 6h16M4 12h16M4 18h16'
              }
            />
          </svg>
        </button>
        <div
          id={`${id}-nav`}
          className={`${styles.navigation} ${mobileOpen ? styles.open : ''}`}
        >
          <nav aria-label="Main navigation" className={styles.links}>
            {navigation.map((item) => (
              <div
                className={`${styles.item} ${item.label === 'News' ? styles.active : ''}`}
                key={item.label}
              >
                <div className={styles.label}>
                  <a
                    href={item.href}
                    aria-current={item.label === 'News' ? 'true' : undefined}
                    onClick={close}
                  >
                    {item.label}
                  </a>
                  <button
                    type="button"
                    aria-label={`${item.label} menu`}
                    aria-expanded={expanded === item.label}
                    aria-controls={`${id}-${item.label}`}
                    ref={(element) => {
                      toggleRefs.current[item.label] = element;
                    }}
                    onClick={() =>
                      setExpanded(expanded === item.label ? null : item.label)
                    }
                  >
                    <svg
                      className={styles.chevron}
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                    >
                      <path d="m4 6 4 4 4-4" />
                    </svg>
                  </button>
                </div>
                <div
                  className={styles.dropdown}
                  id={`${id}-${item.label}`}
                  hidden={expanded !== item.label}
                  inert={expanded !== item.label}
                >
                  {item.links.map(([label, href, icon]) => (
                    <a href={href} key={label} onClick={close}>
                      <NavigationIcon name={icon} />
                      <span className={styles.iconLabel}>{label}</span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className={styles.actions}>
            <a
              className={styles.primary}
              href="/good-news-in-conservation"
              onClick={close}
            >
              <span className={styles.goodNewsIcon} aria-hidden="true" />
              <span>Good News</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
