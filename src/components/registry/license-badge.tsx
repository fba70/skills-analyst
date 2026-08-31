import { Ban, Copy, FileQuestion, Scale } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * What the licence lets us do, stated plainly.
 *
 * The distinction users care about is not the SPDX id but whether we hold a copy — a
 * `metadata_only` skill is real, indexed and judged, and its text lives only upstream.
 * Saying so directly avoids the impression that something is missing or broken.
 */

const POSTURES = {
  mirror_allowed: {
    icon: Copy,
    label: "Mirrored",
    detail: "Licence permits copying; we hold a verified copy.",
    className: "text-primary border-primary/40 bg-primary/10",
  },
  attribution_required: {
    icon: Scale,
    label: "Mirrored · attribution",
    detail: "Copy permitted with attribution, which is shown wherever the content appears.",
    className: "text-primary border-primary/40 bg-primary/10",
  },
  metadata_only: {
    icon: Ban,
    label: "Not mirrored",
    detail: "Licence does not permit copying. Indexed and judged; content stays upstream.",
    className: "text-muted-foreground border-border bg-muted/50",
  },
  unresolved: {
    icon: FileQuestion,
    label: "Licence unresolved",
    detail: "No licence could be identified, so nothing is copied. Treated as not-mirrorable.",
    className: "text-muted-foreground border-border bg-muted/50",
  },
} as const;

export type Posture = keyof typeof POSTURES;

/**
 * The four postures in the order they narrow, most permissive first.
 *
 * Exported so the reference page can enumerate them from the same source the badges render
 * from. A hand-typed list on that page would be a fifth definition of the licence
 * vocabulary and the first one to go stale.
 */
export const POSTURE_KEYS = [
  "mirror_allowed",
  "attribution_required",
  "metadata_only",
  "unresolved",
] as const satisfies readonly Posture[];

export function LicenseBadge({
  redistribution,
  spdx,
  className,
}: {
  redistribution: string;
  spdx?: string | null;
  className?: string;
}) {
  const posture = POSTURES[redistribution as Posture] ?? POSTURES.unresolved;
  const Icon = posture.icon;
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", posture.className, className)}>
      <Icon className="size-3.5" />
      {spdx ?? posture.label}
    </Badge>
  );
}

export function licensePostureDetail(redistribution: string): string {
  return (POSTURES[redistribution as Posture] ?? POSTURES.unresolved).detail;
}

export function licensePostureLabel(redistribution: string): string {
  return (POSTURES[redistribution as Posture] ?? POSTURES.unresolved).label;
}
