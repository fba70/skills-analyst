import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { AttributionCard } from "@/components/archetypes/attribution-card";
import { BlocksCard } from "@/components/archetypes/blocks-card";
import { EvidenceCard } from "@/components/archetypes/evidence-card";
import { ExemplarsCard } from "@/components/archetypes/exemplars-card";
import { ArchetypeOutcomeCard } from "@/components/archetypes/outcome-card";
import { SkeletonCard } from "@/components/archetypes/skeleton-card";
import { TraitsCard } from "@/components/archetypes/traits-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { archetypeDetail } from "@/server/analytics/archetype-read";
import { archetypeOutcomes } from "@/server/analytics/outcomes";

export async function generateMetadata(
  props: PageProps<"/archetypes/[category]">,
): Promise<Metadata> {
  const { category } = await props.params;
  const archetype = await archetypeDetail(category);
  if (!archetype) return { title: "Archetype" };
  return {
    title: `${archetype.label} — archetype`,
    description: `What a good ${archetype.label.toLowerCase()} skill looks like, derived from ${archetype.distinctStructures} distinct structures across ${archetype.sourceCount} sources.`,
  };
}

/**
 * One category's archetype (Doc 2 R3.2 skeleton, R3.3 exemplars, R3.4 attribution).
 *
 * The order of the page is the order an author needs it in: the shape to write, then the
 * conventions to follow, then the ones to avoid, then real skills that do it, and only then
 * the evidence and the credits. Putting the sample size first would be more rigorous and
 * less useful — nobody checks the provenance of guidance they have not read yet.
 *
 * Everything is a server component. There is no state on this page, nothing to filter and
 * nothing to toggle, so shipping a client bundle for it would buy nothing.
 */
export default async function ArchetypePage(props: PageProps<"/archetypes/[category]">) {
  // Public (R8.1 in spirit): archetype snapshots are CC BY-SA and the free tier is what the
  // flywheel runs on. The paid products are the live API and org-scoped blends, neither of
  // which this page is.
  const { category } = await props.params;
  const archetype = await archetypeDetail(category);
  if (!archetype) notFound();

  /*
   * Read unscoped, and that is what `outcome_signals`' open read policy is for: an archetype is a
   * fact about the whole corpus, so aggregating one tenant at a time would be useless — the same
   * argument `builder_signals` makes, and safe for the same reason, which is the column list.
   */
  const outcomes = await archetypeOutcomes();

  return (
    <div className="grid min-w-0 gap-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/archetypes">
            <ArrowLeft className="size-4" />
            Archetypes
          </Link>
        </Button>
      </div>

      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{archetype.label}</h1>
          <Badge variant="outline">v{archetype.version}</Badge>
        </div>
        <p className="text-muted-foreground max-w-3xl">{archetype.description}</p>
        <p className="text-muted-foreground text-sm">
          Derived from {archetype.distinctStructures.toLocaleString()} distinct structures
          across {archetype.sourceCount} sources ·{" "}
          <Link
            href={`/skills?category=function:${archetype.category}`}
            className="hover:text-foreground underline underline-offset-4"
          >
            browse the {archetype.skillCount.toLocaleString()} skills in this category
          </Link>
        </p>
      </header>

      <SkeletonCard skeleton={archetype.skeleton} />

      {/*
        Blocks sit directly under the skeleton because they are the same claim at a finer
        grain — which sections, then what goes inside them — and an author reads down.
      */}
      <BlocksCard blocks={archetype.skeleton.blocks} />

      <TraitsCard
        title="What curated skills do"
        description="Choices markedly more common in skills from curated sources than in the rest of the corpus. Percentages are curated / everything else."
        traits={archetype.skeleton.traits ?? []}
        tone="do"
      />

      <TraitsCard
        title="What they avoid"
        description="The same measurement read backwards: markedly more common outside the curated band than inside it. Not a prohibition — a signal worth a second look."
        traits={archetype.antiPatterns}
        tone="avoid"
      />

      <ExemplarsCard
        exemplars={archetype.exemplars}
        retired={archetype.retiredExemplars}
        categoryLabel={archetype.label}
      />

      <EvidenceCard archetype={archetype} />

      {/*
        R6.3's attribution half (plan step E4), last because it is the emptiest and the most
        forward-looking: everything above describes what the corpus contains, and this describes
        what happened to the skills built from it.
      */}
      <ArchetypeOutcomeCard category={archetype.category} rows={outcomes} />

      <AttributionCard contributors={archetype.contributors} />
    </div>
  );
}
