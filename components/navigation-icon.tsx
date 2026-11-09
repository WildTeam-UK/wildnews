import styles from './site-navigation.module.css';

// Small outline SVGs share the header's stroke, colour and optical label alignment.
const paths = {
  search: 'M21 21l-5-5M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 8l-2 6-6 2 2-6Z',
  leaf: 'M20 3C10 3 4 7 4 14a6 6 0 0 0 6 6c7 0 10-7 10-17ZM4 21 16 8',
  heart:
    'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  news: 'M4 3h16v17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1ZM8 7h8M8 11h8M8 15h3m3 0h2M8 18h3m3 0h2',
  sparkles:
    'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4',
  mail: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM3 6l9 7 9-7',
  book: 'M12 5C8 2 4 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-2-1-6-2-10 1Zm0 0v15',
  badge: 'M17 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM8 12l-2 9 6-3 6 3-2-9',
  gift: 'M3 8h18v4H3ZM5 12v9h14v-9M12 8v13M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z',
  users:
    'M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v2',
  chart: 'M3 3v18h18M7 16l5-5 4 3 5-8M17 6h4v4',
  handshake:
    'm2 12 4-8 5 2h3l4-2 4 8-4 3-5 5-3-1-5-4Zm4-8 5 2-4 4 3 2 4-4 5 6M7 16l3-3m0 6 3-3m0 4 3-3',
  message: 'M21 4H3v14h5l4 4v-4h9ZM7 8h10M7 12h7',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4M12 2V1',
  settings: 'M4 7h8m4 0h4M4 17h3m4 0h9M12 4v6m4-6v6M7 14v6m4-6v6',
  logout: 'M9 3H4v18h5M9 12h12m-4-4 4 4-4 4',
} as const;

export function NavigationIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg className={styles.menuIcon} viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
