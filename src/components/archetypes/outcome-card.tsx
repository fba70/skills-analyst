import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MIN_DISTINCT_SKILLS, type ArchetypeOutcomes } from "@/server/analytics/outcomes";

/**
 * What happened to skills scaffolded from each version of this archetype (RK.7, R6.3).
 *
 * ## This is the loop's last unclosed half, rendered honestly rather than hidden
 *
 * Everything the platform says about "what good looks like" is a claim about **what the corpus
 * contains** — prevalence, lift, the shape of other people's documents. R6.3 asks for the other
 * kind of evidence: what happened to the skills built from that advice. The signals exist now;
 * the *attribution* does not, because only skills published through the builder carry archetype
 * lineage and there is essentially one.
 *
 * So the panel's job is mostly to say that. A version with three downloads must not read as
 * evidence about a category, and the natural way to build this — render whatever numbers exist —
 * is exactly how it would.
 *
 * `usable` is false below `MIN_DISTINCT_SKILLS`, which serves R6.5 and privacy at once for the
 * same reason `MIN_DISTINCT_ORGS` does in creation telemetry: an aggregate over one or two
 * skills describes those skills. Relaxing it for either purpose breaks the other.
 */
export function ArchetypeOutcomeCard({
  category,
  rows,
}: {
  category: string;
  rows: ArchetypeOutcomes[];
}) {
  const mine = rows
    .filter((row) => row.category === category)
    .sort((a, b) => b.version - a.version);

  if (mine.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">What happened next</CardTitle>
          <CardDescription>
            Nothing yet. Only skills published through the builder carry archetype lineage, so
            this fills in as authored skills accumulate downloads and re-validations — not from
            the ingested corpus, which was never scaffolded from anything.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What happened next</CardTitle>
        <CardDescription>
          Outcomes for skills authored from each version of this archetype. This is the half of
          the loop that measures results rather than corpus prevalence — and it is deliberately
          silent until there are enough skills for a number to mean anything.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-2">
        <ul className="grid gap-2">
          {mine.map((row) => (
            <li key={row.version} className="grid gap-0.5 rounded-md border p-3">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">v{row.version}</span>
                <span className="text-muted-foreground text-xs">
                  {row.skills} skill{row.skills === 1 ? "" : "s"}
                </span>
                {row.usable ? (
                  <span className="ml-auto tabular-nums">
                    {row.downloads} download{row.downloads === 1 ? "" : "s"}
                    {row.adverseRate !== null ? ` · ${row.adverseRate}% adverse` : ""}
                  </span>
                ) : (
                  /*
                   * Below the floor the counts are withheld rather than greyed out. A muted
                   * number is still a number somebody will read and quote, and this one would
                   * describe one or two specific skills rather than the archetype.
                   */
                  <span className="text-muted-foreground ml-auto text-xs">
                    below {MIN_DISTINCT_SKILLS} skills — not reportable
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          Nothing here feeds archetype mining. Creation telemetry earned that by accumulating
          enough signal to survive trimming; this has not, and wiring a near-empty input into the
          thing that scaffolds every future draft is how a loop poisons itself with its own noise.
        </p>
      </CardContent>
    </Card>
  );
}
