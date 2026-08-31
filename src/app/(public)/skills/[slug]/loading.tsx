import { PageSkeleton } from "@/components/common/page-skeleton";

/** A skill page is several cards, so the fallback is taller than the list's. */
export default function Loading() {
  return <PageSkeleton rows={4} />;
}
