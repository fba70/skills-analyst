import "server-only";

/**
 * Shared paging for the admin lists.
 *
 * Lives on its own so `admin.ts` and `curation.ts` cannot drift into two slightly
 * different definitions of "page 2".
 */

export const ADMIN_PAGE_SIZES = [5, 10, 20] as const;
export type AdminPageSize = (typeof ADMIN_PAGE_SIZES)[number];
export const DEFAULT_ADMIN_PAGE_SIZE: AdminPageSize = 10;

export type Paged<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: AdminPageSize;
  pageCount: number;
};

export type PageQuery = { page?: number; pageSize?: number };

/** Clamps a requested page against the real total, so a stale link lands on a full page. */
export function pageWindow(total: number, page?: number, size?: number) {
  const pageSize = (ADMIN_PAGE_SIZES as readonly number[]).includes(size ?? 0)
    ? (size as AdminPageSize)
    : DEFAULT_ADMIN_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page ?? 1), pageCount);
  return { pageSize, pageCount, page: current, offset: (current - 1) * pageSize };
}
