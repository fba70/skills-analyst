import Link from "next/link";
import { Star } from "lucide-react";

import { qualityBand } from "@/lib/quality";
import { LicenseBadge } from "@/components/registry/license-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { labelFor } from "@/server/taxonomy/vocabulary";
import type { SkillListItem } from "@/server/dal/skills";

/**
 * One result row, shared by the registry and `/tools/<id>`.
 *
 * Extracted rather than copied when the tool pages arrived. Both lists are `listSkills`
 * output rendered the same way, and a second copy is where the two quietly diverge — one
 * gains a badge, the other keeps rounding a score differently, and a reader who saw a skill
 * on one page does not recognise it on the other.
 *
 * The whole card is one `<Link>`, so **nothing inside may be an anchor**: an anchor inside an
 * anchor is invalid HTML, browsers disagree about what the click means, and the card's own
 * navigation stops being predictable. That is why the badges here are not wrapped in
 * `Explain` the way the detail page wraps its own, and why the registry puts a single plain
 * explanation link near its filters instead.
 */
export function SkillRow({ skill }: { skill: SkillListItem }) {
  return (
    <Link
      href={`/skills/${skill.slug}`}
      className="hover:border-primary/50 focus-visible:ring-ring block rounded-xl outline-hidden focus-visible:ring-2"
    >
      <Card className="transition-colors">
        <CardContent className="grid gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-medium">{skill.name}</span>
            <QualityScore score={skill.qualityScore} />
            <LicenseBadge redistribution={skill.redistribution} spdx={skill.licenseSpdx} />
            {skill.categories
              .filter((c) => c.axis === "function")
              .slice(0, 1)
              .map((c) => (
                <Badge key={c.value} variant="secondary">
                  {labelFor("function", c.value)}
                </Badge>
              ))}
            {skill.categories
              .filter((c) => c.axis === "domain")
              .slice(0, 1)
              .map((c) => (
                <Badge key={c.value} variant="outline">
                  {labelFor("domain", c.value)}
                </Badge>
              ))}
            {skill.variantCount > 0 ? (
              <Badge variant="outline" className="text-muted-foreground text-xs">
                +{skill.variantCount} near-duplicate
                {skill.variantCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {skill.stars !== null ? (
              /*
                Upstream stars, as a badge like every other fact on the card.
                `fill-current` is what makes the icon read as a star rather than an outline —
                a stroke-only star at 12px is mush.

                Amber, not the primary colour: this is the one number on the card that is
                *not* ours. Doc 2 R2.9 is explicit that popularity must never outrank a
                failed or unscored skill, so it should look like what it is — an upstream
                signal sitting alongside our verdict, not competing with it.

                It is the *repository's* star count, not the skill's, and every skill in a
                repo carries the same number. That reads as a bug when ten cards in a row
                show 279,495, so the tooltip names the repository rather than leaving the
                number to be misread as a property of the skill.
              */
              <Badge
                variant="outline"
                className="gap-1 text-xs font-normal"
                title={
                  skill.sourceName
                    ? `${skill.sourceName} has ${skill.stars.toLocaleString()} stars on GitHub — a property of the repository, shared by every skill in it`
                    : `${skill.stars.toLocaleString()} stars on GitHub`
                }
              >
                <Star
                  aria-hidden
                  className="size-3 fill-current text-amber-500 dark:text-amber-400"
                />
                {skill.stars.toLocaleString()}
              </Badge>
            ) : null}
          </div>
          {skill.summary ? (
            <p className="text-muted-foreground line-clamp-2 text-sm">{skill.summary}</p>
          ) : null}
          <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
            <span>{skill.sourceName}</span>
            <span>{skill.dialect.replace(/_/g, " ")}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Quality leads the default sort and appears on every row (Doc 2 R2.9): popularity must
 * never outrank a failed or unscored skill, so stars stay the quietest element here.
 */
export function QualityScore({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground text-xs">
        unscored
      </Badge>
    );
  }
  // Bands come from `lib/quality.ts`, shared with the scorer and the reference page — a
  // legend that disagrees with the badge it explains is worse than no legend.
  const band = qualityBand(score);
  const tone =
    band === "strong"
      ? "text-primary border-primary/40 bg-primary/10"
      : band === "fair"
        ? "text-amber-600 border-amber-500/40 bg-amber-500/10 dark:text-amber-400"
        : "text-destructive border-destructive/40 bg-destructive/10";
  return (
    <Badge variant="outline" className={`text-xs font-medium ${tone}`}>
      {score}/100
    </Badge>
  );
}
