import { LiftChip } from "@/components/archetypes/lift-bar";
import { ExplainLink } from "@/components/registry/explain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeviationReport } from "@/server/builder/deviation";

/**
 * How this draft compares to its archetype, block by block (R4.3).
 *
 * ## It is written so it cannot become a checklist
 *
 * The obvious version of this panel is a list of ticks and crosses with a score. That would
 * be the archetype homogenisation Doc 2's risk register names, delivered by the one surface
 * with the most leverage over what gets written — and it would be wrong on its own terms,
 * because a skill with no decisions to make should not carry a decision rule and no
 * measurement here knows which case the author is in.
 *
 * So the copy does three things deliberately: it states prevalence rather than a verdict, it
 * says out loud that skipping a block can be right, and it never blocks anything. Publishing
 * is gated on the analyzers (R4.5) and on nothing here.
 *
 * ## Nothing negative is inferred from absence in the grammar
 *
 * Block types the draft contains that the archetype does not list appear under a heading that
 * says only what they are. Two types measure negative lift corpus-wide and the miner
 * deliberately refuses to publish that as guidance, because the detector may be measuring
 * house style — so telling an author here that an unlisted block type is a problem would
 * smuggle in through the builder the exact claim `archetype.ts` declines to make.
 */
export function DeviationCard({ report }: { report: DeviationReport }) {
  if (report.notMeasured) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-base">Compared to the archetype</CardTitle>
          <CardDescription>
            The {report.categoryLabel.toLowerCase()} archetype (v{report.archetypeVersion}) was
            mined before blocks were measured, so there is nothing to compare against yet.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          Compared to the archetype
          <span className="text-muted-foreground text-xs font-normal">
            {report.categoryLabel.toLowerCase()} v{report.archetypeVersion} ·{" "}
            {report.totalBlocks} blocks in this draft
          </span>
        </CardTitle>
        <CardDescription>
          What the well-regarded skills in this category write, and what this draft contains.
          A difference is worth a look, not a correction — skipping a block on purpose is a
          normal thing for a good skill to do.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {report.missing.length > 0 ? (
          <section className="grid gap-2">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              In the archetype, not in this draft
            </h3>
            <ul className="grid gap-2">
              {report.missing.map((block) => (
                <li key={block.type} className="grid gap-0.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{block.label}</span>
                    {block.required ? (
                      <Badge variant="secondary" className="text-[11px]">
                        expected
                      </Badge>
                    ) : null}
                    <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2">
                      <span className="font-mono text-xs tabular-nums">
                        {block.strongPrevalence}% / {block.weakPrevalence}%
                      </span>
                      <LiftChip lift={block.lift} />
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">{block.blurb}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <p className="text-muted-foreground text-sm">
            This draft contains every block type the archetype lists for{" "}
            {report.categoryLabel.toLowerCase()}.
          </p>
        )}

        {report.followed.length > 0 ? (
          <section className="grid gap-2 border-t pt-4">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              In both
            </h3>
            <ul className="grid gap-1">
              {report.followed.map((block) => (
                <li
                  key={block.type}
                  className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                >
                  <span>{block.label}</span>
                  {/*
                    Density beside the count, phrased as a comparison and never as a target.
                    Inclusion in the archetype was decided on presence; these means were
                    never significance tested, and a panel that demanded 4.3 procedures
                    would be enforcing an untested statistic.
                  */}
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {block.drafted} here · {block.strongDensity.toFixed(1)} typical
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {report.extra.length > 0 ? (
          <section className="grid gap-2 border-t pt-4">
            <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Also in this draft
            </h3>
            <p className="text-muted-foreground text-xs">
              Block types the archetype does not list for this category. That is not a
              finding about them: a type earns a place only by separating the two bands, and
              plenty of useful writing does not.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {report.extra.map((block) => (
                <li key={block.type}>
                  <Badge variant="outline" className="font-normal">
                    {block.label}
                    <span className="text-muted-foreground ml-1 tabular-nums">
                      {block.drafted}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs">
          <span>
            {report.unclassified} of {report.totalBlocks} passages match no block type, which
            is ordinary content rather than a defect.
          </span>
          <ExplainLink anchor="archetypes">What a block is</ExplainLink>
        </div>
      </CardContent>
    </Card>
  );
}
