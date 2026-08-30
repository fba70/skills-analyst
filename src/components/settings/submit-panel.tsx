"use client";

import { useState, useTransition } from "react";
import { ListPlus, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  applySeedsAction,
  expandListAction,
  submitRepoAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Where an admin points the platform at new sources (Doc 2 R1.8, Doc 4 §4 steps 1–2).
 *
 * Three doors, in descending order of how much they add per click, because they answer
 * three different questions:
 *
 *   - **Seed allow-list** — "start from a known-good baseline." One click, ~14 vendor and
 *     high-signal repos, reproducible in any environment.
 *   - **Curated list** — "someone else already did the curation." Reads an awesome-list
 *     repo for the GitHub links inside it and queues each as a candidate. This is the
 *     scalable door: the list re-syncs, so new entries arrive without anyone editing code.
 *   - **Single repository** — "I found this one myself."
 *
 * None of them shortcut anything. Every candidate still goes through enrich → decide →
 * sync → licence resolution → validation. These change *what is found and in what order*,
 * never what happens to it afterwards.
 */

export type SourceDiversityRow = {
  source: string;
  skills: number;
  structures: number;
  diversity: number;
};

export function SubmitPanel({
  diversity,
  minDiversityPercent,
}: {
  diversity: SourceDiversityRow[];
  minDiversityPercent: number;
}) {
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        A source added here joins the same pipeline the crawl feeds — checked for skills,
        then synced, licence-resolved and validated like any other. Nothing here skips
        validation.
      </p>

      <SeedCard />

      <div className="grid gap-4 lg:grid-cols-2">
        <ListCard />
        <RepoCard />
      </div>

      <DiversityCard rows={diversity} minDiversityPercent={minDiversityPercent} />
    </div>
  );
}

function SeedCard() {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const outcome = await applySeedsAction();
      setResult(outcome);
      if (outcome.ok) toast.success("Seed list applied", { description: outcome.message });
      else toast.error("Seed list failed", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Apply the seed allow-list</CardTitle>
        <CardDescription>
          The hand-picked baseline: first-party vendor repos (Anthropic, Vercel, Stripe,
          Cloudflare, Sentry, Trail of Bits, Hugging Face, Expo) and the high-signal
          community packs. Safe to re-run — repositories already known are updated, not
          duplicated.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={isPending} size="sm">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            Apply seed list
          </Button>
          {isPending ? (
            <span className="text-muted-foreground text-xs">
              Reading each repository — this takes a minute.
            </span>
          ) : null}
        </div>
        <Result result={result} />
      </CardContent>
    </Card>
  );
}

function ListCard() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    const target = url.trim();
    if (!target) return;
    startTransition(async () => {
      const outcome = await expandListAction(target);
      setResult(outcome);
      if (outcome.ok) {
        toast.success("List expanded", { description: outcome.message });
        setUrl("");
      } else {
        toast.error("Not expanded", { description: outcome.message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Expand a curated list</CardTitle>
        <CardDescription>
          Reads an awesome-list repository for the GitHub links inside it and queues each
          as a candidate. The list itself is never fetched for content — only for who it
          points at.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isPending) run();
          }}
          aria-label="Curated list repository"
          placeholder="VoltAgent/awesome-agent-skills"
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
        />
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={isPending || url.trim().length === 0} size="sm">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ListPlus className="size-4" />
            )}
            Expand list
          </Button>
        </div>
        <Result result={result} />
      </CardContent>
    </Card>
  );
}

function RepoCard() {
  const [url, setUrl] = useState("");
  const [includePaths, setIncludePaths] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    const target = url.trim();
    if (!target) return;
    startTransition(async () => {
      const outcome = await submitRepoAction(target, includePaths);
      setResult(outcome);
      if (outcome.ok) {
        toast.success("Repository added", { description: outcome.message });
        setUrl("");
        setIncludePaths("");
      } else {
        toast.error("Not added", { description: outcome.message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add one repository</CardTitle>
        <CardDescription>
          Checked before it is accepted: it must exist and actually contain SKILL.md or
          AGENTS.md files.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isPending) run();
          }}
          aria-label="Repository"
          placeholder="https://github.com/owner/name  ·  or  owner/name"
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
        />
        <input
          value={includePaths}
          onChange={(event) => setIncludePaths(event.target.value)}
          aria-label="Include paths"
          placeholder="include paths, e.g. workspaces/  — only for very large repos"
          className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
        />
        <p className="text-muted-foreground text-xs">
          GitHub&rsquo;s file listing truncates above roughly 100,000 entries, and we refuse
          a truncated one rather than index part of a repository as if it were all of it.
          Naming the directories that hold the skills reads those directly.
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={isPending || url.trim().length === 0} size="sm">
            {isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add repository
          </Button>
        </div>
        <Result result={result} />
      </CardContent>
    </Card>
  );
}

/**
 * Structural diversity by source — distinct document skeletons per skill.
 *
 * This replaced a share-of-corpus chart, and the reason is worth keeping: share was
 * measuring the wrong thing and getting it wrong in both directions. `aws/agent-toolkit`
 * contributes 120 skills across 104 structures (87%) — large and genuinely varied.
 * `google/adk-kotlin` contributes 15 across 1 (7%) — tiny and a single skeleton repeated.
 * A share chart flags the first and ignores the second; exactly backwards.
 *
 * What damages the foundry is structural monoculture, not concentration: an archetype
 * mined from one skeleton repeated 300 times describes a generator, not a convention. So
 * this is the number on the wall, and it is diagnostic rather than a gate — volume is
 * wanted, and nothing here rejects a source.
 */
function DiversityCard({
  rows,
  minDiversityPercent,
}: {
  rows: SourceDiversityRow[];
  minDiversityPercent: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Structural diversity by source</CardTitle>
        <CardDescription>
          Distinct document skeletons as a share of each source&rsquo;s skills. Below{" "}
          {minDiversityPercent}% a source is a generator rather than a collection — many
          skills, one shape. Size is not the signal: a large source can be varied and a
          small one can be entirely cloned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing fingerprinted yet — run Extract structure on the Ingestion tab.
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => {
              const low = row.diversity < minDiversityPercent;
              return (
                <li key={row.source} className="grid gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate">{row.source}</span>
                    <span
                      className={`shrink-0 tabular-nums text-xs ${
                        low ? "text-destructive font-medium" : "text-muted-foreground"
                      }`}
                    >
                      {row.skills} skills · {row.structures} shapes · {row.diversity}%
                    </span>
                  </div>
                  <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                    <div
                      className={`h-full rounded-full ${low ? "bg-destructive" : "bg-primary"}`}
                      style={{ width: `${Math.min(100, row.diversity)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p
      className={`rounded-md px-3 py-2 text-xs ${
        result.ok ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
      }`}
    >
      {result.message}
    </p>
  );
}
