import { CookieSettingsButton } from '@/components/analytics-consent';

type FooterLink = {
  label: string;
  href?: string;
};

const footerColumns: Array<{ title: string; links: FooterLink[] }> = [
  {
    title: 'About',
    links: [
      { label: 'Our team', href: 'https://www.wildteam.org.uk/team' },
      { label: 'Our plan', href: 'https://www.wildteam.org.uk/conservation-plan' },
      { label: 'Our impact', href: 'https://www.wildteam.org.uk/conservation-impact' },
      { label: 'Our partners', href: 'https://www.wildteam.org.uk/conservation-partners' },
      { label: 'How we use AI', href: '/how-we-use-ai' },
      { label: 'Get in touch', href: 'https://training.wildteam.org.uk/contact-us' },
      { label: 'Community', href: 'https://training.wildteam.org.uk/social' },
      { label: 'Newsletter', href: 'https://training.wildteam.org.uk/newsletter' },
    ],
  },
  {
    title: 'Explore',
    links: [
      { label: 'Success stories', href: 'https://training.wildteam.org.uk/success-stories' },
      { label: 'Blog', href: 'https://training.wildteam.org.uk/blog' },
      { label: 'Courses', href: 'https://training.wildteam.org.uk/courses' },
      { label: 'Bursaries', href: 'https://training.wildteam.org.uk/bursaries' },
      { label: 'Best practices' },
      { label: 'Team membership', href: 'https://training.wildteam.org.uk/pricing-teams' },
      { label: 'Conservation Trainers Network', href: 'https://training.wildteam.org.uk/conservation-trainers-network' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms and conditions', href: 'https://training.wildteam.org.uk/terms' },
      { label: 'Cookies', href: 'https://training.wildteam.org.uk/cookies' },
      { label: 'Privacy Policy', href: 'https://training.wildteam.org.uk/privacy' },
      { label: 'Annual report', href: 'https://register-of-charities.charitycommission.gov.uk/charity-search/-/charity-details/5031203' },
      { label: 'CPD', href: 'https://training.wildteam.org.uk/cpd-certification' },
    ],
  },
];

const socialLinks = [
  { label: 'WildTeam on LinkedIn', href: 'https://www.linkedin.com/company/wildteam-uk/', network: 'linkedin' },
  { label: 'WildTeam on YouTube', href: 'https://www.youtube.com/channel/UCUUcxfaUjtX4dl4zs4gMjSg', network: 'youtube' },
  { label: 'WildTeam on Facebook', href: 'https://www.facebook.com/WildTeamUK/', network: 'facebook' },
  { label: 'WildTeam on Instagram', href: 'https://www.instagram.com/wildteamuk/', network: 'instagram' },
] as const;

const socialIconPaths = {
  linkedin: 'M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.55V9h3.57v11.45Z',
  youtube: 'M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19 31.38 31.38 0 0 0 0 12a31.38 31.38 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14A31.38 31.38 0 0 0 24 12a31.38 31.38 0 0 0-.5-5.81ZM9.55 15.57V8.43L15.82 12l-6.27 3.57Z',
  facebook: 'M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z',
  instagram: 'M12 2.16c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.67 4.77-4.92 4.92-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85C2.38 3.92 3.9 2.38 7.15 2.23 8.42 2.17 8.8 2.16 12 2.16ZM12 0C8.74 0 8.33.01 7.05.07 2.7.27.27 2.69.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.2 4.36 2.63 6.78 6.98 6.98C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c4.35-.2 6.78-2.62 6.98-6.98.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95C23.73 2.69 21.3.27 16.95.07 15.67.01 15.26 0 12 0Zm0 5.84A6.16 6.16 0 1 0 12 18.16 6.16 6.16 0 0 0 12 5.84Zm0 10.16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.41-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88Z',
} as const;

function SocialIcon({ network }: { network: keyof typeof socialIconPaths }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={socialIconPaths[network]} /></svg>;
}

function FooterColumn({ title, links, includeCookieSettings = false }: { title: string; links: FooterLink[]; includeCookieSettings?: boolean }) {
  return <section className="wildteam-footer-column">
    <h2>{title}</h2>
    {links.map((link) => link.href
      ? <a href={link.href} target="_blank" rel="noopener noreferrer" key={link.label}>{link.label}</a>
      : <span key={link.label}>{link.label}</span>)}
    {includeCookieSettings ? <CookieSettingsButton /> : null}
  </section>;
}

export function SiteFooter() {
  return <footer className="wildteam-footer">
    <div className="shell wildteam-footer-inner">
      <div className="wildteam-footer-grid">
        {footerColumns.map((column) => <FooterColumn {...column} includeCookieSettings={column.title === 'Legal'} key={column.title} />)}
        <section className="wildteam-footer-column">
          <h2>Join the conversation</h2>
          <div className="wildteam-social-links">
            {socialLinks.map(({ label, href, network }) => <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label} key={label}><SocialIcon network={network} /></a>)}
          </div>
          <a className="wildteam-cpd-link" href="https://training.wildteam.org.uk/cpd-certification" target="_blank" rel="noopener noreferrer">
            {/* oxlint-disable-next-line next/no-img-element -- shared WildTeam certification asset */}
            <img src="https://lwfiles.mycourse.app/6874ec826e31c5cf606cc001-public/24d306bb870071d95fb156827191ca00.png" alt="CPD Member certification" loading="lazy" decoding="async" />
          </a>
        </section>
      </div>
      <div className="wildteam-footer-mission">
        <h2>Empowering conservationists to restore nature</h2>
        <p>We give conservationists worldwide the knowledge, the skills, and the community support they need to design and deliver conservation projects that have more impact.</p>
        <small>WILDTEAM is a registered charity in England and Wales. Number 1149465. © {new Date().getFullYear()} by WildTeam</small>
      </div>
    </div>
  </footer>;
}
