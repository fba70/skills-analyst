import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { isCautionState, LIFECYCLE_META, type LifecycleState } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";

/**
 * How proven a skill is (Doc 6 RK.1), and what to do about it.
 *
 * Two components, because the two states of the world want different amounts of the
 * reader's attention. A `validated` skill gets a quiet badge among the others; a superseded
 * one gets a notice above the download, because the single most useful thing that page can
 * do is send the reader to the replacement instead.
 *
 * ## The notice sits above the download and does not disable it
 *
 * Same judgement as the withdrawal notice: a greyed-out button beside "replaced by X"
 * invites a reader to look for a way round the block, whereas a sentence naming the
 * replacement gives them somewhere better to go. Deprecated is not withdrawn — the licence
 * still permits the download and the bytes are still what was validated — so refusing it
 * would be us overriding an author's *advice* with a prohibition they did not ask for.
 */

const TONE_BADGE = {
  neutral: "text-muted-foreground",
  good: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
  warn: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  bad: "text-red-600 dark:text-red-400 border-red-500/40",
} as const;

const TONE_CARD = {
  neutral: "",
  good: "",
  warn: "border-amber-500/40 bg-amber-500/5",
  bad: "border-red-500/40 bg-red-500/5",
} as const;

export function LifecycleBadge({ state }: { state: LifecycleState | null }) {
  /*
   * Nothing at all for a skill that is not indexed. The derivation returns null there
   * because "how proven is it" is not a question worth answering about something nobody may
   * install, and a second badge would compete with the notice that says why.
   */
  if (state === null) return null;

  const meta = LIFECYCLE_META[state];
  return (
    <Badge variant="outline" className={cn("font-normal", TONE_BADGE[meta.tone])}>
      {meta.label}
    </Badge>
  );
}

export function LifecycleNotice({
  state,
  note,
  reviewBy,
  supersededBy,
}: {
  state: LifecycleState | null;
  note: string | null;
  reviewBy: Date | null;
  supersededBy: { slug: string; name: string } | null;
}) {
  // Only the states that should change what a reader does. `validated` and `battle-tested`
  // are the badge's job; a card telling someone everything is fine is furniture.
  if (!isCautionState(state)) return null;

  const meta = LIFECYCLE_META[state as LifecycleState];

  return (
    <Card className={cn(TONE_CARD[meta.tone])}>
      <CardContent className="grid gap-2 py-4 text-sm">
        <p className="font-medium">{meta.label}</p>
        <p className="text-muted-foreground">{meta.blurb}</p>

        {/* The curator's own words, when there are any. Never invented. */}
        {note ? <p className="text-muted-foreground italic">“{note}”</p> : null}

        {supersededBy ? (
          <p>
            Use{" "}
            <Link
              href={`/skills/${supersededBy.slug}`}
              className="font-medium underline underline-offset-4"
            >
              {supersededBy.name}
            </Link>{" "}
            instead.
          </p>
        ) : null}

        {/*
          Superseded with no resolvable replacement is a real state, not an error: the
          replacement may have been quarantined since. Saying so beats a dead link, and beats
          silently rendering the badge with nothing behind it.
        */}
        {state === "superseded" && !supersededBy ? (
          <p className="text-muted-foreground">
            The replacement is no longer servable, so it is not linked here.
          </p>
        ) : null}

        {state === "stale" && reviewBy ? (
          <p className="text-muted-foreground">
            Review was due {reviewBy.toISOString().slice(0, 10)}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
