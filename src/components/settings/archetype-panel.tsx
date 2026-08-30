"use client";

import { useState, useTransition } from "react";
import { Loader2, Shapes } from "lucide-react";
import { toast } from "sonner";

import { mineArchetypesAction, type ActionResult } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { labelFor } from "@/server/taxonomy/vocabulary";

/**
 * Mined archetypes (Doc 2 R3.2).
 *
 * Each row is a category's current skeleton, with the evidence beside it rather than
 * behind a link — `structures / sources` is what the R3.2 gate is on, and a reader
 * checking whether guidance is trustworthy should not have to go looking for the sample
 * size it came from.
 *
 * The sections are shown with their **lift**, not their prevalence. A section present in
 * 90% of good skills and 90% of weak ones is not advice; the number that earns its place
 * in a skeleton is the gap between the bands, and displaying prevalence alone would invite
 * exactly the misreading the mining method exists to avoid.
 */

export type ArchetypeRow = {
  category: string;
  version: number;
  skillCount: number;
  distinctStructures: number;
  sourceCount: number;
  sections: Array<{ role: string; lift: number; required: boolean }>;
  antiPatterns: Array<{ label: string; lift: number }>;
};

export function ArchetypePanel({ archetypes }: { archetypes: ArchetypeRow[] }) {
  return (
    <div className="grid gap-4">
      <MineCard count={archetypes.length} />

      {archetypes.length === 0 ? null : (
        <div className="grid gap-3 lg:grid-cols-2">
          {archetypes.map((row) => (
            <ArchetypeCard key={row.category} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function MineCard({ count }: { count: number }) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const outcome = await mineArchetypesAction();
      setResult(outcome);
      if (outcome.ok) toast.success("Archetypes", { description: outcome.message });
      else toast.error("Archetypes", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Shapes className="text-muted-foreground size-4" />
          Mine archetypes
        </CardTitle>
        <CardDescription>
          Derives, per function category, what distinguishes the skills that work from the
          ones that do not — sections, conventions and anti-patterns, each traceable to the
          corpus evidence behind it. Free: computed from stored fingerprints, no model.
          Categories below the evidence gate are skipped rather than mined thin.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={isPending} size="sm">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Shapes className="size-4" />
            )}
            Mine all categories
          </Button>
          {count > 0 ? (
            <span className="text-muted-foreground text-xs">
              {count} categor{count === 1 ? "y has" : "ies have"} an archetype
            </span>
          ) : null}
        </div>
        {result ? (
          <p
            className={`rounded-md px-3 py-2 text-xs ${
              result.ok ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
            }`}
          >
            {result.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ArchetypeCard({ row }: { row: ArchetypeRow }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {labelFor("function", row.category)}
          <Badge variant="outline">v{row.version}</Badge>
        </CardTitle>
        <CardDescription>
          {row.distinctStructures.toLocaleString()} distinct structures from{" "}
          {row.sourceCount} sources
          {row.skillCount > row.distinctStructures ? (
            <> · {row.skillCount.toLocaleString()} skills before de-duplication</>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {row.sections.length > 0 ? (
          <div className="grid gap-1.5">
            <h4 className="text-xs font-medium tracking-wide uppercase">Sections</h4>
            <ul className="grid gap-1">
              {row.sections.map((section) => (
                <li
                  key={section.role}
                  className="flex items-baseline justify-between gap-2 text-sm"
                >
                  <span>
                    {section.required ? (
                      <span aria-label="expected" className="text-primary mr-1">
                        ▪
                      </span>
                    ) : (
                      <span aria-hidden className="text-muted-foreground/40 mr-1">
                        ·
                      </span>
                    )}
                    {section.role.replace(/-/g, " ")}
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums text-xs">
                    +{section.lift}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No section distinguishes the strong band from the weak one in this category.
          </p>
        )}

        {row.antiPatterns.length > 0 ? (
          <div className="grid gap-1.5">
            <h4 className="text-xs font-medium tracking-wide uppercase">Avoid</h4>
            <ul className="grid gap-1">
              {row.antiPatterns.slice(0, 4).map((anti) => (
                <li
                  key={anti.label}
                  className="text-muted-foreground flex items-baseline justify-between gap-2 text-sm"
                >
                  <span>{anti.label}</span>
                  <span className="shrink-0 tabular-nums text-xs">{anti.lift}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs">
          Numbers are <strong>lift</strong>: how much more common the element is among the
          category&rsquo;s strongest skills than its weakest.
        </p>
      </CardContent>
    </Card>
  );
}
