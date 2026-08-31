import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { sectionRoleLabel } from "@/lib/section-roles";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { archetypeIndex, EVIDENCE_GATE } from "@/server/analytics/archetype-read";
import type { ArchetypeIndexEntry } from "@/server/analytics/archetype-read";

export const metadata: Metadata = {
  title: "Archetypes",
  description:
    "What a good skill in each category actually looks like, derived from the corpus rather than asserted.",
};

/**
 * The archetype index (Doc 2 R3.2–R3.4).
 *
 * Public, like the registry. Doc 1 licenses archetype snapshots CC BY-SA and sells the
 * *live API* and org-scoped blends — so the pages themselves belong on the free tier, where
 * they do the job the tier exists for: they are the argument for the whole platform. A
 * registry that only lists skills is a directory; the claim here is that the corpus teaches
 * you something, and until now that claim was a database table nobody could read.
 *
 * ## Categories with no archetype are listed anyway
 *
 * Twelve of thirteen function categories have cleared the evidence gate. Hiding the
 * thirteenth would make the page look finished and tell an author nothing about where the
 * corpus is thin — which, at a sixth of the way through ingestion, is the more honest and
 * more useful signal.
 */
export default async function ArchetypesPage() {
  const entries = await archetypeIndex();

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Archetypes</h1>
        <p className="text-muted-foreground max-w-3xl">
          What a good skill in a category actually looks like — derived from the corpus, not
          asserted. Each archetype contrasts skills from a curated allow-list of repositories
          against everything else, and keeps only the elements that <em>separate</em> them.
          An element common to both is a description of markdown, not advice.
        </p>
      </div>

      <ul className="grid gap-3 lg:grid-cols-2">
        {entries.map((entry) => (
          <li key={entry.category}>
            <ArchetypeTile entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ArchetypeTile({ entry }: { entry: ArchetypeIndexEntry }) {
  if (entry.version === null) return <PendingTile entry={entry} />;

  const headline = entry.sections.slice(0, 4);
  const topTrait = entry.traits[0];

  return (
    <Link
      href={`/archetypes/${entry.category}`}
      className="hover:border-primary/50 focus-visible:ring-ring block h-full rounded-xl outline-hidden focus-visible:ring-2"
    >
      <Card className="h-full transition-colors">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {entry.label}
            <Badge variant="outline">v{entry.version}</Badge>
          </CardTitle>
          <CardDescription>
            {entry.distinctStructures.toLocaleString()} distinct structures across{" "}
            {entry.sourceCount} sources
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {headline.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {headline.map((section) => (
                <Badge
                  key={section.role}
                  variant={section.required ? "secondary" : "outline"}
                  className="font-normal"
                >
                  {sectionRoleLabel(section.role)}
                  <span className="text-muted-foreground ml-1 font-mono tabular-nums">
                    +{section.lift}
                  </span>
                </Badge>
              ))}
              {entry.sections.length > headline.length ? (
                <Badge variant="ghost" className="text-muted-foreground font-normal">
                  +{entry.sections.length - headline.length} more
                </Badge>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No section separates the bands in this category.
            </p>
          )}

          {topTrait ? (
            <p className="text-muted-foreground text-sm">
              Strongest convention: <span className="text-foreground">{topTrait.label}</span> —{" "}
              {topTrait.strongPrevalence}% of curated skills against {topTrait.weakPrevalence}%
              of the rest.
            </p>
          ) : null}

          <p className="text-primary flex items-center gap-1 text-sm font-medium">
            Read the archetype
            <ArrowRight className="size-3.5" />
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * A category the gate has refused.
 *
 * Deliberately not a link and deliberately not styled as a failure. The gate refusing is the
 * gate working — R3.2 exists so an archetype cannot be built from too little or too narrow
 * evidence — and the tile says what is missing rather than implying something is broken.
 */
function PendingTile({ entry }: { entry: ArchetypeIndexEntry }) {
  return (
    <Card className="h-full border-dashed">
      <CardHeader>
        <CardTitle className="text-muted-foreground">{entry.label}</CardTitle>
        <CardDescription>Not enough evidence yet</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          An archetype needs {EVIDENCE_GATE.structures} distinct document structures from at
          least {EVIDENCE_GATE.sources} sources before it says anything an author should act
          on. This category has not reached that, and is reported rather than mined thin.
        </p>
      </CardContent>
    </Card>
  );
}
