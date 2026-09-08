import { blockTypeBlurb, blockTypeLabel } from "@/lib/block-types";
import { BandLegend, LiftBar, LiftChip } from "@/components/archetypes/lift-bar";
import { ExplainLink } from "@/components/registry/explain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SkeletonBlock } from "@/server/analytics/archetype";

/**
 * The block grammar (Doc 6 RW.1) — what the passages inside those sections are doing.
 *
 * ## Why this card exists beside the skeleton
 *
 * The skeleton stopped discriminating. At 97% corpus coverage the strong and weak bands both
 * write a `steps` heading, and the best *section* lift across the three largest categories is
 * +10. Blocks are the level where the difference is still visible: `reference-pointer` clears
 * its threshold in 11 of 13 categories at a median +18 and `decision-rule` in 10 of 13 at
 * +21. Everyone writes steps now. Not everyone writes a decision rule inside them.
 *
 * ## Density is shown and is not the reason anything is here
 *
 * Inclusion is decided on **presence**, by the identical rule the sections use, so the two
 * lists carry comparable numbers. The counts are printed underneath because they say
 * something presence cannot — a curated `review` skill carries 4.3 procedures against 3.2 —
 * but they are descriptive: no significance test was run on a mean, and a card that ranked
 * by density would be reporting an untested statistic in the same typeface as a tested one.
 *
 * ## No negative claims here, deliberately
 *
 * Two types measure negative and neither is published as guidance. The reasoning is in
 * `archetype.ts` where the decision is made: the `anti-example` detector fires on markers,
 * so its negative lift may be measuring house style rather than the absence of failure-mode
 * knowledge, and "write fewer anti-examples" is advice that would do real damage if the
 * measurement is wrong. A negative claim invites an author to delete something, which is why
 * it needs a better instrument than this one before it earns a place on the page.
 */
export function BlocksCard({ blocks }: { blocks: SkeletonBlock[] | undefined }) {
  /*
   * Three states, not two. A row mined before miner 3.0.0 has no `blocks` key at all, and
   * telling that reader "no block separates the bands" would be a claim about the corpus
   * made from the absence of a measurement.
   */
  if (blocks === undefined) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle>The block grammar</CardTitle>
          <CardDescription>Not measured for this version</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            This archetype was mined before blocks were extracted, so nothing here is a
            statement about the category. The next mine measures them.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>The block grammar</CardTitle>
        <CardDescription>
          What the passages inside those sections are doing, in the order a curated skill puts
          them. Sections say what a document is about; blocks say what work it does — and at
          full corpus coverage this is the level where curated skills still differ from the
          rest.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {blocks.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No block type separates the two bands in this category by enough to be worth
            acting on. Every type was measured; the evidence panel below says how much
            evidence there was to measure it against.
          </p>
        ) : (
          <>
            <ol className="grid gap-4">
              {blocks.map((block, index) => (
                <li key={block.type} className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted-foreground w-5 shrink-0 font-mono text-xs tabular-nums">
                      {index + 1}
                    </span>
                    <span className="font-medium">{blockTypeLabel(block.type)}</span>
                    {block.required ? (
                      <Badge variant="secondary" className="text-[11px]">
                        expected
                      </Badge>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-muted-foreground font-mono text-xs tabular-nums">
                        {block.strongPrevalence}% / {block.weakPrevalence}%
                      </span>
                      <LiftChip lift={block.lift} />
                    </span>
                  </div>
                  <div className="pl-7">
                    <p className="text-muted-foreground mb-2 text-sm">
                      {blockTypeBlurb(block.type)}
                    </p>
                    <LiftBar strong={block.strongPrevalence} weak={block.weakPrevalence} />
                    {/*
                      How many, once we know they write any. Phrased as a comparison rather
                      than a bare mean, because "4.3" alone reads as a target to hit.
                    */}
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      Where present: {block.strongDensity.toFixed(1)} per curated skill against{" "}
                      {block.weakDensity.toFixed(1)} elsewhere · usually{" "}
                      {positionPhrase(block.typicalPosition)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="grid gap-2 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <BandLegend />
                <ExplainLink anchor="archetypes">What a block is</ExplainLink>
              </div>
              <p className="text-muted-foreground text-xs">
                Ordered by where a curated skill puts them, not by lift.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Position in words, because 0.62 is not a place in a document.
 *
 * The number is a normalised median — block order divided by the document's last block —
 * which is meaningful to the miner and meaningless to an author. Thirds are as much
 * precision as the underlying measurement supports.
 */
function positionPhrase(position: number): string {
  if (position < 0.34) return "near the top";
  if (position < 0.67) return "in the middle";
  return "near the end";
}
