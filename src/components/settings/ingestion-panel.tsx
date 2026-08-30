"use client";

import { useState, useTransition } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import {
  clusterAction,
  consistencyAction,
  extractStructuresAction,
  promoteAction,
  runCrawlAction,
  signaturesAction,
  syncPendingAction,
  validateAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Manual triggers for the ingestion pipeline.
 *
 * The four stages in order, each bounded. Running them by hand is how the discovery and
 * validation policy gets tuned — you change a threshold, run a slice, and look at what
 * came back. A scheduler will drive the same functions later; this is the loop that makes
 * the thresholds worth setting.
 */

type Stage = {
  key: string;
  title: string;
  description: string;
  cta: string;
  amountLabel: string;
  amount: number;
  run: (amount: number) => Promise<ActionResult>;
};

const STAGES: Stage[] = [
  {
    key: "crawl",
    title: "1 · Discover",
    description:
      "Reads the next shards of the GitHub code-search space and records the repositories found. Saturated shards split automatically.",
    cta: "Run crawl",
    amountLabel: "shards",
    amount: 3,
    run: runCrawlAction,
  },
  {
    key: "promote",
    title: "2 · Promote",
    description:
      "Fetches metadata for discovered repositories, then applies the discovery policy: promote, hold for review, or skip with a reason.",
    cta: "Enrich & decide",
    amountLabel: "repos",
    amount: 25,
    run: promoteAction,
  },
  {
    key: "sync",
    title: "3 · Sync",
    description:
      "Fetches skills from promoted sources, resolves each licence, and stores only what the licence permits copying.",
    cta: "Sync sources",
    amountLabel: "sources",
    amount: 2,
    run: syncPendingAction,
  },
  {
    key: "validate",
    title: "4 · Validate",
    description:
      "Runs the rule-based analyzers over everything awaiting a verdict. Nothing reaches the registry until it passes.",
    cta: "Validate",
    amountLabel: "versions",
    amount: 50,
    run: validateAction,
  },
  {
    key: "signatures",
    title: "5 · Fingerprint",
    description:
      "Reads each validated bundle once and stores a MinHash signature. The expensive half of duplicate detection, and resumable.",
    cta: "Build signatures",
    amountLabel: "versions",
    amount: 200,
    run: signaturesAction,
  },
  {
    key: "cluster",
    title: "6 · Cluster duplicates",
    description:
      "Finds candidates from stored LSH bands, then re-reads each candidate's text to confirm it with an exact similarity rather than an estimate.",
    cta: "Cluster",
    amountLabel: "pairs",
    amount: 300,
    run: clusterAction,
  },
  {
    key: "structures",
    title: "7 · Extract structure",
    description:
      "Reads each validated bundle and records its shape — heading roles, body metrics, resource layout, description conventions. Rule-based and free; this is the evidence archetype mining reads.",
    cta: "Fingerprint structure",
    amountLabel: "versions",
    amount: 200,
    run: extractStructuresAction,
  },
  {
    key: "consistency",
    title: "8 · Audit documentation",
    description:
      "R2.3: asks a model whether each skill's documentation honestly describes its bundled code — the gap the rule-based analyzers cannot see. Only skills that ship code are audited. COSTS MONEY per skill; capped at 25 a run.",
    cta: "Run audit",
    amountLabel: "skills",
    amount: 10,
    run: consistencyAction,
  },
];

export function IngestionPanel() {
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        Each run does a bounded slice. A full crawl takes days and a full sync hours, while
        a serverless request is capped at 800 seconds — so these report what one slice did
        rather than pretending to finish.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {STAGES.map((stage) => (
          <StageCard key={stage.key} stage={stage} />
        ))}
      </div>
    </div>
  );
}

function StageCard({ stage }: { stage: Stage }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [amount, setAmount] = useState(stage.amount);

  function trigger() {
    startTransition(async () => {
      const outcome = await stage.run(amount);
      setResult(outcome);
      if (outcome.ok) toast.success(stage.title, { description: outcome.message });
      else toast.error(stage.title, { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{stage.title}</CardTitle>
        <CardDescription>{stage.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {stage.amountLabel ? (
            <>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(event) => setAmount(Number(event.target.value) || 1)}
                aria-label={`${stage.title} — ${stage.amountLabel}`}
                className="border-input bg-background focus-visible:ring-ring h-9 w-20 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
              />
              <span className="text-muted-foreground text-sm">{stage.amountLabel}</span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">whole corpus</span>
          )}
          <Button onClick={trigger} disabled={isPending} size="sm" className="ml-auto">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            {stage.cta}
          </Button>
        </div>

        {result ? (
          <p
            className={`rounded-md px-3 py-2 text-xs ${
              result.ok
                ? "bg-muted text-muted-foreground"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            {result.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
