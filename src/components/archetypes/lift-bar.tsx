import { cn } from "@/lib/utils";

/**
 * The one chart on these pages, and the reason there is only one.
 *
 * An archetype element is a **contrast**: a section present in 90% of good skills and 90%
 * of weak ones is not advice. Showing a single prevalence bar would say "55% of review
 * skills have a when-to-use section", which is a fact about markdown; showing both bands
 * says "55% of the curated ones do, against 41% of everything else", which is the finding.
 *
 * So both bars are always drawn, on the same track, at the same scale. The visible gap
 * between them *is* the lift. A reader who ignores every number still comes away with the
 * right impression, and a reader who reads the numbers cannot mistake prevalence for
 * guidance — the misreading the whole mining method exists to avoid.
 *
 * `tone` flips which band is emphasised. For an anti-pattern the weak band is the higher
 * one and colouring it like a recommendation would invert the advice.
 */
export function LiftBar({
  strong,
  weak,
  tone = "do",
}: {
  /** Prevalence in the curated band, 0–100. */
  strong: number;
  /** Prevalence in everything else, 0–100. */
  weak: number;
  tone?: "do" | "avoid";
}) {
  return (
    <div className="grid gap-1" aria-hidden>
      <Track value={strong} className={tone === "do" ? "bg-primary" : "bg-muted-foreground/40"} />
      <Track
        value={weak}
        className={tone === "do" ? "bg-muted-foreground/40" : "bg-destructive/60"}
      />
    </div>
  );
}

function Track({ value, className }: { value: number; className: string }) {
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div
        className={cn("h-full rounded-full", className)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/**
 * The signed gap, as a number.
 *
 * Always signed, never bare. "+23" and "23" read identically at a glance and mean opposite
 * things when the second one is negative, which is exactly the case an anti-pattern is.
 */
export function LiftChip({ lift }: { lift: number }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-4xl px-1.5 py-0.5 font-mono text-xs tabular-nums",
        lift >= 0 ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
      )}
      title={`${Math.abs(lift)} points ${lift >= 0 ? "more" : "less"} common among curated sources`}
    >
      {lift >= 0 ? "+" : "−"}
      {Math.abs(lift)}
    </span>
  );
}

/** The legend, written once so every bar on the page inherits its meaning. */
export function BandLegend({ className }: { className?: string }) {
  return (
    <p className={cn("text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
      <span className="flex items-center gap-1.5">
        <span className="bg-primary h-1.5 w-6 rounded-full" />
        curated sources
      </span>
      <span className="flex items-center gap-1.5">
        <span className="bg-muted-foreground/40 h-1.5 w-6 rounded-full" />
        every other source
      </span>
    </p>
  );
}
