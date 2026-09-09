"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toast } from "sonner";

import { importSkillAction } from "@/app/(protected)/build/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Improve an existing skill (Doc 2 R5.6, plan step C6).
 *
 * The first entry into the builder that does not begin with a blank page. Everything downstream
 * is the Compose flow unchanged — block editing, deviation marks, the library, the eval lab —
 * because C1 made a draft typed blocks and an imported document is just more of them.
 *
 * ## It says what forking costs before you press the button
 *
 * Importing somebody else's skill carries their licence and their credit into whatever you
 * publish. That is stated here rather than discovered on the publish screen, because a person
 * who would not have forked under those terms should find out while it is still free to stop.
 * The refusals are equally specific: *this licence does not permit copying* is a different
 * sentence from *no such skill*, and it tells the reader to link out rather than to retry.
 */

export function ImportPanel({
  categories,
}: {
  categories: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const outcome = await importSkillAction(slug, category);
      if (!outcome.ok) {
        toast.error("Import", { description: outcome.message });
        return;
      }
      const { source, resources } = outcome.data;
      toast.success("Imported", {
        description:
          `${source === "forked" ? "Forked" : source === "owned" ? "Opened your skill" : "Imported"}` +
          `${resources > 0 ? ` with ${resources} bundled file${resources === 1 ? "" : "s"}` : ""}.`,
      });
      router.push(`/build/${outcome.data.draftId}`);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Improve an existing skill</CardTitle>
        <CardDescription>
          Start from a skill that already exists — one of yours, or any registry skill whose
          licence permits copying. It arrives as typed blocks, so the archetype comparison, the
          block library and the eval lab all apply to it straight away.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="skill slug, or paste its registry URL"
            disabled={isPending}
            className="h-9 min-w-0 flex-1 text-sm"
          />
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            disabled={isPending}
            className="border-input bg-background h-9 min-w-0 rounded-md border px-2 text-sm"
          >
            <option value="">Function category…</option>
            {categories.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <Button onClick={submit} disabled={isPending || !slug.trim() || !category}>
            Import
          </Button>
        </div>
        {/*
          Said before the button, not after it.

          Forking carries the upstream licence and credit into anything published from the draft.
          Somebody who would not accept that should learn it while stopping is still free — and
          the platform saying so plainly is the same posture as the block library having no copy
          button.
        */}
        <p className="text-muted-foreground text-xs">
          Forking somebody else&rsquo;s skill carries their licence and their attribution into
          whatever you publish from it. A skill whose licence does not permit copying cannot be
          imported at all; its registry page stays readable and you can link to it.
        </p>
      </CardContent>
    </Card>
  );
}
