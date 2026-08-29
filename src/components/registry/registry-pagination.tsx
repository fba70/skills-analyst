import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

/**
 * Server-rendered pagination: plain links, so it works before hydration and each page is
 * a real URL. The current filters ride along in the query string.
 */
export function RegistryPagination({
  page,
  pageCount,
  searchParams,
}: {
  page: number;
  pageCount: number;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (pageCount <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "page" || value === undefined) continue;
      params.set(key, Array.isArray(value) ? value[0] : value);
    }
    if (target > 1) params.set("page", String(target));
    return params.toString() ? `/skills?${params}` : "/skills";
  };

  return (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href={href(Math.max(1, page - 1))}
            aria-disabled={page === 1}
            className={page === 1 ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>

        {pagesToShow(page, pageCount).map((entry, index) =>
          entry === "…" ? (
            <PaginationItem key={`gap-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={entry}>
              <PaginationLink href={href(entry)} isActive={entry === page}>
                {entry}
              </PaginationLink>
            </PaginationItem>
          ),
        )}

        <PaginationItem>
          <PaginationNext
            href={href(Math.min(pageCount, page + 1))}
            aria-disabled={page === pageCount}
            className={page === pageCount ? "pointer-events-none opacity-50" : undefined}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

/** First, last, and a window around the current page; gaps become an ellipsis. */
function pagesToShow(page: number, pageCount: number): Array<number | "…"> {
  const window = new Set<number>([1, pageCount, page, page - 1, page + 1]);
  const pages = [...window].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);

  const output: Array<number | "…"> = [];
  let previous = 0;
  for (const current of pages) {
    if (previous && current - previous > 1) output.push("…");
    output.push(current);
    previous = current;
  }
  return output;
}
