import { PageSkeleton } from "@/components/common/page-skeleton";

/** Makes navigation to this segment instant; the wait moves somewhere the user can see it. */
export default function Loading() {
  return <PageSkeleton rows={4} />;
}
