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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PipelineBacklog } from "@/server/pipeline/run";

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
  /**
   * Why the default is this number.
   *
   * Without it the eight inputs read as arbitrary, and an operator tuning one has no way to
   * tell whether 3 is small because the work is slow or because the queue is short. Every
   * one of these is sized against the same constraint — a serverless request dies at 800
   * seconds — so what differs is what a single unit costs.
   */
  why: string;
  /** Model calls, or not. The only distinction on this page that spends money. */
  costs?: "money";
  /** Which backlog figure is the denominator, when one is knowable. */
  queue: (backlog: PipelineBacklog) => number | null;
  /** What that denominator counts, in words. */
  queueLabel: string;
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
    why:
      "Three because one shard is up to ten paged search calls against a rate limit of 30 a minute — the ceiling here is GitHub's, not ours.",
    queue: (backlog) => backlog.shardsPending,
    queueLabel: "shards unread",
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
    why:
      "Twenty-five because deciding a repository is one metadata call each, and the policy check itself is local.",
    queue: (backlog) => backlog.reposAwaitingDecision,
    queueLabel: "undecided",
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
    why:
      "Two, because a source is fetched completely or not at all — one repository can be hundreds of file fetches, and a partial enumeration would tombstone everything it did not reach.",
    queue: (backlog) => backlog.sourcesAwaitingSync,
    queueLabel: "never synced",
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
    why:
      "Fifty: four analyzers over a whole bundle each, all local, but every bundle is read from storage first.",
    queue: (backlog) => backlog.awaitingValidation,
    queueLabel: "awaiting a verdict",
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
    why:
      "Two hundred — one pass over each bundle's text, no network, so the limit is reading and hashing.",
    queue: (backlog) => backlog.awaitingSignature,
    queueLabel: "unsigned",
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
    why:
      "Three hundred: candidates come from stored bands, and only the survivors are re-read for an exact similarity.",
    queue: () => null,
    queueLabel: "pairs are generated at run time, not queued",
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
    why:
      "Two hundred, same shape as fingerprinting — local parsing over bundles already in storage.",
    queue: (backlog) => backlog.awaitingFingerprint,
    queueLabel: "without a current fingerprint",
    run: extractStructuresAction,
  },
  {
    key: "consistency",
    title: "8 · Audit documentation",
    description:
      "Checks whether each skill's documentation honestly describes its bundled code — the gap the rule-based analyzers cannot see. Only skills that ship code are audited. Costs per skill; capped at 25 a run.",
    cta: "Run audit",
    amountLabel: "skills",
    amount: 10,
    why:
      "Ten, and this is the only number here chosen for cost rather than time: it is one model call per skill. The run refuses above 25.",
    queue: (backlog) => backlog.skillsAwaitingAudit,
    queueLabel: "with code, never audited",
    costs: "money",
    run: consistencyAction,
  },
];

export function IngestionPanel({ backlog }: { backlog: PipelineBacklog }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <p className="text-muted-foreground max-w-3xl text-sm">
          <span className="text-foreground">The numbering is a dependency chain, not an
          order of preference.</span>{" "}
          Each stage consumes what the previous one produced: validation needs synced
          versions, fingerprints and signatures need validated ones, clustering needs
          signatures, and archetype mining reads structures.
        </p>
        <p className="text-muted-foreground max-w-3xl text-sm">
          {/*
            Said plainly because the cost of not saying it is already on record: running
            these individually instead of the whole pass is how fingerprints fell 1,566
            behind the corpus and dedup signatures 2,240. Neither shortfall raises an error
            — they look like a smaller corpus — and both starve the next phase.
          */}
          <span className="text-foreground">Run the pipeline above is the normal
          control.</span>{" "}
          These are for advancing or tuning one stage at a time. Running them separately is
          how derived data drifts behind the corpus: nothing errors, it just looks like a
          smaller corpus.
        </p>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Each number is a <span className="text-foreground">ceiling for one run</span>, not
          a target — every default is sized so a slice finishes inside the 800-second
          request cap, so what differs between them is what a single unit costs.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {STAGES.map((stage) => (
          <StageCard key={stage.key} stage={stage} backlog={backlog} />
        ))}
      </div>
    </div>
  );
}

function StageCard({ stage, backlog }: { stage: Stage; backlog: PipelineBacklog }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [amount, setAmount] = useState(stage.amount);
  const queue = stage.queue(backlog);

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
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {stage.title}
          {/*
            A badge, not a sentence in the fourth line of a paragraph.
            
            Seven of these stages are free and one calls a model per skill. That difference
            decides whether an operator can press the button without thinking, and it was
            previously distinguishable only by reading to the end of a description on a card
            that looks identical to the other seven.
          */}
          {stage.costs === "money" ? (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              costs money
            </Badge>
          ) : (
            <Badge variant="secondary">free</Badge>
          )}
        </CardTitle>
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
              <span className="text-muted-foreground min-w-0 text-sm">
                {stage.amountLabel}
                {/*
                  The denominator, which is what turns an arbitrary number into a decision.
                  `null` where there is genuinely no queue to count — clustering generates
                  its candidates at run time — and saying so is better than printing a zero
                  that would read as "nothing to do".
                */}
                {queue === null ? null : (
                  <span className="tabular-nums"> of {queue.toLocaleString()}</span>
                )}
              </span>
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

        <p className="text-muted-foreground text-xs">
          {queue === null ? stage.queueLabel : `${queue.toLocaleString()} ${stage.queueLabel}`}
          {" · "}
          {stage.why}
        </p>

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
