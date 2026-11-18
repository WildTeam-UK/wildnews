/* oxlint-disable next/no-html-link-for-pages -- archive navigation uses full page loads, like the archive cards */
import { archivePagePath, ARCHIVE_PAGE_SIZE } from '@/lib/archive-pagination';

export function ArchivePagination({ path, page, total }: { path: string; page: number; total: number }) {
  const pages = Math.ceil(total / ARCHIVE_PAGE_SIZE);
  if (pages <= 1) return null;
  return <nav className="archive-pagination shell" aria-label="Archive pages">
    {page > 1 ? <a className="action-button" rel="prev" href={archivePagePath(path, page - 1)}>Newer stories</a> : <span />}
    <span>Page {page} of {pages}</span>
    {page < pages ? <a className="action-button" rel="next" href={archivePagePath(path, page + 1)}>Older stories</a> : <span />}
  </nav>;
}
