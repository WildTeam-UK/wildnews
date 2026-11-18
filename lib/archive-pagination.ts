export const ARCHIVE_PAGE_SIZE = 24;

export function archivePageNumber(value: string | string[] | undefined): number | null {
  if (value === undefined) return 1;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && Number.isSafeInteger(page * ARCHIVE_PAGE_SIZE) ? page : null;
}

export function archivePagePath(path: string, page: number): string {
  return page === 1 ? path : `${path}?page=${page}`;
}
