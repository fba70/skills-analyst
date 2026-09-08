import { Activity } from "lucide-react";

import { ExplainLink } from "@/components/registry/explain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BATTLE_TESTED, OUTCOME_META, type OutcomeKind } from "@/lib/outcomes";
import type { SkillOutcomes } from "@/server/analytics/outcomes";

/**
 * What has happened to this skill since it was published (Doc 6 RK.7, plan step E4).
 *
 * ## The one panel here that is about results rather than about the document
 *
 * Every other card on this page describes the artefact: what the analyzers found, what it may be
 * used for, what it costs to load. This one describes what the world did with it — and until B1
 * the platform had no way to say anything at all, which is why `outcomesForSkill` sat written and
 * unread for a milestone.
 *
 * ## It does not render a battle-tested badge, and that is deliberate
 *
 * `outcomesForSkill` computes one, and so does `lifecycleExpression()` in SQL — with
 * **precedence**: a deprecated or superseded skill has that state whatever its download count.
 * Two badges from two computations would eventually disagree in front of a reader, and the
 * lifecycle badge in the header is the one that owns the answer.
 *
 * So this shows the **evidence** instead, and what is still missing when the bar is not met.
 * That is the more useful half anyway: "battle-tested" tells you nothing you can act on, and
 * "18 of 25 downloads, no re-validation yet" tells you exactly what the tier is waiting for.
 *
 * ## Counted since collection began, not since the skill existed
 *
 * Most of this corpus was indexed before the recorder shipped. A skill first seen in August
 * reading "0 downloads" would say *nobody wanted it* when the truth is *nobody was counting*, so
 * the window travels with the numbers.
 */
export function ImpactCard({
  outcomes,
  collectionStart,
}: {
  outcomes: SkillOutcomes;
  /** When the first signal of any kind was recorded. Null when none ever has been. */
  collectionStart: Date | null;
}) {
  if (collectionStart === null) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4" />
            Impact
          </CardTitle>
          <CardDescription>
            Nothing has been recorded yet, anywhere. This is the absence of collection rather
            than the absence of interest.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  /*
   * Indexed before anybody was counting. Worth saying on the skill's own page rather than only
   * in a footnote, because it is the difference between a zero that means something and one that
   * means nothing.
   */
  const predatesCollection =
    outcomes.firstIndexedAt !== null && outcomes.firstIndexedAt < collectionStart;

  const missing = [
    outcomes.downloads < BATTLE_TESTED.minDownloads
      ? `${outcomes.downloads} of ${BATTLE_TESTED.minDownloads} downloads`
      : null,
    outcomes.revalidatedPass < BATTLE_TESTED.minRevalidations
      ? "no clean re-validation yet"
      : null,
    outcomes.adverse > BATTLE_TESTED.adverseAllowed
      ? `${outcomes.adverse} adverse signal${outcomes.adverse === 1 ? "" : "s"}`
      : null,
  ].filter((entry): entry is string => entry !== null);

  const recorded = Object.entries(outcomes.byKind).filter(([, count]) => count > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4" />
          Impact
        </CardTitle>
        <CardDescription>
          What consumers and the pipeline have done with this skill since{" "}
          {collectionStart.toISOString().slice(0, 10)}
          {predatesCollection ? ", which is after it was first indexed" : ""}.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure label="Downloads" value={outcomes.downloads} blurb="deduplicated per reader per day" />
          <Figure
            label="Clean re-validations"
            value={outcomes.revalidatedPass}
            blurb="passed analyzers newer than it"
          />
          <Figure
            label="Adverse"
            value={outcomes.adverse}
            blurb="upheld reports and quarantines"
          />
        </div>

        {/*
          The breakdown lists only kinds that actually occurred. A row of zeros for every kind
          in the vocabulary would be five lines saying nothing and would bury the one that did.
        */}
        {recorded.length > 1 ? (
          <ul className="text-muted-foreground grid gap-0.5 text-xs">
            {recorded.map(([kind, count]) => (
              <li key={kind} className="flex justify-between gap-2">
                <span>{OUTCOME_META[kind as OutcomeKind]?.label ?? kind}</span>
                <span className="tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs">
          <span>
            {missing.length === 0
              ? "It meets every condition for the battle-tested tier."
              : `Towards battle-tested: ${missing.join(", ")}.`}
          </span>
          <ExplainLink anchor="lifecycle">What these mean</ExplainLink>
        </div>
      </CardContent>
    </Card>
  );
}

function Figure({ label, value, blurb }: { label: string; value: number; blurb: string }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-lg tabular-nums">{value}</span>
      <span className="text-sm">{label}</span>
      <span className="text-muted-foreground text-xs">{blurb}</span>
    </div>
  );
}
