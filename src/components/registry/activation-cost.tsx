import { Badge } from "@/components/ui/badge";
import { COST_BAND_META, costBand, formatTokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";

/**
 * What a skill costs the agent that loads it (Doc 6 RW.9).
 *
 * One component for both surfaces that show it — the public skill page and the builder's
 * draft view — because an author comparing "what mine costs" against "what a published one
 * costs" has to be reading the same number computed the same way. Two components would
 * eventually round differently, and the whole point of the figure is comparison.
 *
 * ## It always says "est."
 *
 * Not decoration. The figure comes from a character-count approximation, not a tokenizer
 * (see `lib/tokens.ts`), so it is honest for comparing two documents and dishonest as a
 * claim about someone's context window. The label is the one thing on this component that
 * must not be trimmed for tidiness — a number that looks measured and is not is worse than
 * no number, because a reader who later discovers the gap stops trusting the surfaces that
 * *are* exact.
 */

const BAND_CLASS = {
  lean: "text-muted-foreground",
  typical: "text-muted-foreground",
  heavy: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  oversized: "text-red-600 dark:text-red-400 border-red-500/40",
} as const;

export function ActivationCostBadge({ tokens }: { tokens: number | null }) {
  // Absent, not zero: during a re-extract campaign most versions have no fingerprint yet,
  // and rendering "0 tokens" would be a claim about the skill rather than about us.
  if (tokens === null) return null;

  const band = costBand(tokens);
  return (
    <Badge variant="outline" className={cn("font-normal", BAND_CLASS[band])}>
      ~{formatTokens(tokens)} tokens
      <span className="text-muted-foreground/70 ml-1.5 text-[10px] uppercase tracking-wide">
        est.
      </span>
    </Badge>
  );
}

/** The fuller form, for a card: the figure, its band, and what the band means. */
export function ActivationCost({ tokens }: { tokens: number | null }) {
  if (tokens === null) {
    return (
      <p className="text-muted-foreground text-sm">
        Not measured yet — this version has no structural fingerprint at the current
        extractor version.
      </p>
    );
  }

  const band = costBand(tokens);
  const meta = COST_BAND_META[band];

  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">~{formatTokens(tokens)}</span>
        <span className="text-muted-foreground text-sm">
          estimated tokens per activation
        </span>
        <Badge variant="outline" className={cn("font-normal", BAND_CLASS[band])}>
          {meta.label}
        </Badge>
      </div>
      <p className="text-muted-foreground text-sm">{meta.blurb}</p>
      {/*
        Stated on the surface rather than left to the FAQ. The reader who most needs to know
        this is the one deciding whether to trust the figure, and they are looking at it now.
      */}
      <p className="text-muted-foreground/80 text-xs">
        Estimated from document size, not counted by a tokenizer, so it is reliable for
        comparing two skills and approximate as an absolute.
      </p>
    </div>
  );
}
