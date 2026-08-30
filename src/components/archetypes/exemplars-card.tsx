import Link from "next/link";

import { LicenseBadge } from "@/components/registry/license-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SkillRef } from "@/server/dal/skills";

/**
 * Exemplars (Doc 2 R3.3) — the skeleton with the abstraction taken back out.
 *
 * A skeleton says a review skill should carry a when-to-use section; an exemplar shows one
 * that does. These are the same skills the builder and the assistant will put in context,
 * so a reader can see exactly what the machine will be reasoning from rather than taking
 * it on trust.
 *
 * ## Licence-clean, and that is a hard filter
 *
 * R1.6 forbids reproducing metadata-only skills in exemplars. The mine already applies it —
 * only `mirror_allowed` and `attribution_required` versions are eligible — but the filter is
 * *named* on this card rather than left implicit, because "these are the best examples" and
 * "these are the best examples we are allowed to show you" are different claims and only the
 * second one is true.
 *
 * ## Resolved live, not from a snapshot
 *
 * The archetype pins exemplar ids so the mine stays reproducible; the names, scores and
 * licences come from the corpus as it stands now. An exemplar quarantined since the mine
 * therefore disappears from this list instead of being recommended forever, and the count
 * of those is shown rather than swallowed.
 */
export function ExemplarsCard({
  exemplars,
  retired,
  categoryLabel,
}: {
  exemplars: SkillRef[];
  retired: number;
  categoryLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Exemplars</CardTitle>
        <CardDescription>
          The highest-scoring skills from curated sources in {categoryLabel.toLowerCase()},
          restricted to those whose licence lets us reproduce them. These are what the
          builder reads in context.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {exemplars.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing licence-clean to show yet. Skills indexed by metadata only are never
            reproduced as exemplars, however good they are.
          </p>
        ) : (
          <ul className="grid gap-2">
            {exemplars.map((skill) => (
              <li key={skill.id}>
                <Link
                  href={`/skills/${skill.slug}`}
                  className="hover:border-primary/50 focus-visible:ring-ring block rounded-lg border p-3 transition-colors outline-hidden focus-visible:ring-2"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">{skill.name}</span>
                    <Badge variant="outline" className="tabular-nums">
                      {skill.qualityScore ?? "—"}/100
                    </Badge>
                    <LicenseBadge
                      redistribution={skill.redistribution}
                      spdx={skill.licenseSpdx}
                    />
                  </div>
                  {skill.summary ? (
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                      {skill.summary}
                    </p>
                  ) : null}
                  {skill.sourceName ? (
                    <p className="text-muted-foreground mt-1 font-mono text-xs">
                      {skill.sourceName}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {retired > 0 ? (
          <p className="text-muted-foreground border-t pt-3 text-xs">
            {retired} exemplar{retired === 1 ? "" : "s"} pinned by this version{" "}
            {retired === 1 ? "is" : "are"} no longer listed — withdrawn upstream or
            quarantined by a later validation pass. The next mine picks {retired === 1 ? "a" : ""}{" "}
            replacement{retired === 1 ? "" : "s"}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
