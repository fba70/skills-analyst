import { Skeleton } from "@/components/ui/skeleton";

/**
 * The fallback a route segment shows while its server component resolves.
 *
 * ## Why this exists at all
 *
 * Next renders a server component before it navigates, so a page whose data takes two
 * seconds leaves the *old* page on screen for two seconds — the click appears to do
 * nothing, and a person clicks again. A `loading.tsx` turns the segment into a Suspense
 * boundary, which makes the navigation itself instant and moves the wait somewhere the user
 * can see it.
 *
 * That is a fix for the *perception*, and it is not a substitute for the page being fast.
 * The registry was taking 2.3 seconds because its filter counts read every indexed row into
 * memory; a spinner over that would have been a nicer way to wait. The query was fixed
 * first, and this is here because half a second of blank screen still reads as a stall.
 *
 * ## Shaped like the page, not a spinner
 *
 * The blocks match the layout that replaces them — heading, controls, a list of rows — so
 * the content does not jump when it arrives. A centred spinner tells the reader that
 * something is happening; a shape tells them what is coming.
 */
export function PageSkeleton({
  rows = 5,
  controls = false,
}: {
  /** Roughly how many list items the real page will show. */
  rows?: number;
  /** Reserve space for a filter or sort bar above the list. */
  controls?: boolean;
}) {
  return (
    // Announced politely rather than silently: a screen reader gets "loading" instead of a
    // page that is inexplicably empty for half a second.
    <div className="grid min-w-0 gap-6" role="status" aria-label="Loading">
      <div className="grid gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      {controls ? (
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      ) : null}

      <div className="grid gap-3">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton
            key={index}
            className="h-20 w-full"
            // Fades down the list so the block reads as one loading region rather than as
            // content that has already arrived.
            style={{ opacity: 1 - index * (0.5 / Math.max(rows, 1)) }}
          />
        ))}
      </div>
    </div>
  );
}
