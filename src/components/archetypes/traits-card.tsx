import { BandLegend, LiftBar, LiftChip } from "@/components/archetypes/lift-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SkeletonTrait } from "@/server/analytics/archetype";

/**
 * Conventions, and their mirror image.
 *
 * "Do" and "Avoid" are the *same measurement* read in two directions — a trait the curated
 * band has and the rest does not, and a trait the rest has and the curated band does not.
 * They are rendered as two cards rather than one list with red and green rows because they
 * answer different questions ("what should I add" / "what should I stop doing") and an
 * author usually arrives with only one of them in mind.
 *
 * An empty "Avoid" card is not rendered at all. A heading over nothing invites the reader
 * to assume the analysis failed, when the honest reading is that nothing in this category
 * is markedly *more* common among the weaker skills.
 */
export function TraitsCard({
  title,
  description,
  traits,
  tone,
}: {
  title: string;
  description: string;
  traits: SkeletonTrait[];
  tone: "do" | "avoid";
}) {
  if (traits.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid gap-3.5">
          {traits.map((trait) => (
            <li key={trait.key} className="grid gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{trait.label}</span>
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">
                    {trait.strongPrevalence}% / {trait.weakPrevalence}%
                  </span>
                  <LiftChip lift={trait.lift} />
                </span>
              </div>
              <LiftBar strong={trait.strongPrevalence} weak={trait.weakPrevalence} tone={tone} />
            </li>
          ))}
        </ul>
        <BandLegend className="border-t pt-4" />
      </CardContent>
    </Card>
  );
}
