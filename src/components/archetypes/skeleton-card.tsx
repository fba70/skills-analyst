import { sectionRoleBlurb, sectionRoleLabel } from "@/lib/section-roles";
import { BandLegend, LiftBar, LiftChip } from "@/components/archetypes/lift-bar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ArchetypeSkeleton } from "@/server/analytics/archetype-read";

/**
 * The skeleton: which sections distinguish the skills that work, in the order they appear.
 *
 * Ordered by `typicalPosition` — the median place the section sits in a curated document —
 * because an author reads this top to bottom and writes in that order. Ranking by lift
 * instead would produce a more impressive-looking list and a worse document.
 *
 * **Not a template.** Every section here earned its place by a margin over the rest of the
 * corpus, which makes it evidence about what good skills do, not a form to fill in. Doc 2's
 * risk register names archetype homogenisation explicitly: anti-patterns are not mandates,
 * and deviation is allowed and tracked. The wording on this card has to keep that true.
 */
export function SkeletonCard({ skeleton }: { skeleton: ArchetypeSkeleton }) {
  const { sections, norms } = skeleton;

  return (
    <Card>
      <CardHeader>
        <CardTitle>The skeleton</CardTitle>
        <CardDescription>
          Sections that appear markedly more often in skills from curated sources than in the
          rest of the corpus, in the order a curated skill usually puts them. A starting
          shape, not a form — a good skill may skip any of these on purpose.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {sections.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No section separates the two bands in this category. Either its skills genuinely
            share no convention, or there is not yet enough evidence to see one — the
            evidence panel below says which.
          </p>
        ) : (
          <>
            {sections.length === 1 ? (
              <p className="text-muted-foreground border-l-2 pl-3 text-sm">
                One section only. That is a thin skeleton, and it is reported rather than
                padded: the other twelve roles were measured and none of them separated the
                bands by enough to be worth telling an author about.
              </p>
            ) : null}

            <ol className="grid gap-4">
              {sections.map((section, index) => (
                <li key={section.role} className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-muted-foreground w-5 shrink-0 font-mono text-xs tabular-nums">
                      {index + 1}
                    </span>
                    <span className="font-medium">{sectionRoleLabel(section.role)}</span>
                    {section.required ? (
                      <Badge variant="secondary" className="text-[11px]">
                        expected
                      </Badge>
                    ) : null}
                    <span className="ml-auto flex items-center gap-2">
                      <span className="text-muted-foreground font-mono text-xs tabular-nums">
                        {section.strongPrevalence}% / {section.weakPrevalence}%
                      </span>
                      <LiftChip lift={section.lift} />
                    </span>
                  </div>
                  <div className="pl-7">
                    <p className="text-muted-foreground mb-2 text-sm">
                      {sectionRoleBlurb(section.role)}
                    </p>
                    <LiftBar strong={section.strongPrevalence} weak={section.weakPrevalence} />
                  </div>
                </li>
              ))}
            </ol>

            <BandLegend className="border-t pt-4" />
          </>
        )}

        <Norms norms={norms} />
      </CardContent>
    </Card>
  );
}

/**
 * Size norms, medians rather than means.
 *
 * A category holds a 90-word stub and a 12,000-word manual, and an average of those two
 * describes neither. The median is the length a curated skill in this category actually is.
 */
function Norms({ norms }: { norms: ArchetypeSkeleton["norms"] }) {
  if (!norms || (norms.medianWords === 0 && norms.medianFileCount === 0)) return null;

  return (
    <div className="grid gap-2 border-t pt-4">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Typical size
      </h3>
      <dl className="grid grid-cols-3 gap-3">
        <Norm label="Body" value={`${norms.medianWords.toLocaleString()} words`} />
        <Norm
          label="Description"
          value={
            norms.medianDescriptionLength > 0 ? `${norms.medianDescriptionLength} chars` : "—"
          }
        />
        <Norm
          label="Files"
          value={`${norms.medianFileCount} file${norms.medianFileCount === 1 ? "" : "s"}`}
        />
      </dl>
      <p className="text-muted-foreground text-xs">
        Medians across the curated band. A category holding both a 90-word stub and a
        12,000-word manual has no meaningful average.
      </p>
    </div>
  );
}

function Norm({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
