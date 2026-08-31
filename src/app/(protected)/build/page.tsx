import type { Metadata } from "next";
import Link from "next/link";

import { BuilderWizard } from "@/components/builder/wizard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { builderCategories } from "@/server/builder/scaffold";
import { listDrafts } from "@/server/builder/drafts";
import { requireSession } from "@/server/dal/session";
import { labelFor } from "@/server/taxonomy/vocabulary";

export const metadata: Metadata = { title: "Build a skill" };

/**
 * The builder's entry point (Doc 2 R4.1).
 *
 * Re-resolves the session itself rather than trusting the group layout — every protected
 * page in this app does, and it costs nothing because the lookup is request-cached.
 *
 * Only the category list is loaded here. The archetype scaffold for the chosen one is
 * fetched by an action once the choice is made: there are thirteen categories and each
 * scaffold is an archetype read plus an exemplar resolution, so eager-loading them would be
 * twelve wasted round trips to render a list of buttons.
 */
export default async function BuildPage() {
  await requireSession();
  const [categories, drafts] = await Promise.all([builderCategories(), listDrafts()]);

  return (
    <div className="grid min-w-0 max-w-4xl gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Build a skill</h1>
        <p className="text-muted-foreground">
          Start from what the corpus shows works in your category, add what is specific to
          you, and let the assistant write the first draft. It is validated by the same
          analyzers the registry uses before you see it.
        </p>
      </div>

      {drafts.length > 0 ? (
        <div className="grid gap-2">
          <h2 className="text-sm font-medium">Your drafts</h2>
          <ul className="grid gap-2">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <Link
                  href={`/build/${draft.id}`}
                  className="hover:border-primary/50 focus-visible:ring-ring block rounded-lg outline-hidden focus-visible:ring-2"
                >
                  <Card>
                    <CardContent className="flex flex-wrap items-center gap-2 py-3">
                      <span className="text-sm font-medium">{draft.name}</span>
                      <Badge variant="outline" className="text-[11px]">
                        {labelFor("function", draft.archetypeCategory)}
                      </Badge>
                      <Badge
                        variant={draft.status === "ready" ? "secondary" : "outline"}
                        className="text-[11px]"
                      >
                        {draft.status}
                      </Badge>
                      {draft.qualityScore !== null ? (
                        <Badge variant="outline" className="text-[11px] tabular-nums">
                          {draft.qualityScore}/100
                        </Badge>
                      ) : null}
                    </CardContent>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <BuilderWizard categories={categories} />
    </div>
  );
}
