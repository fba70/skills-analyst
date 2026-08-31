"use client";

import { useState, useTransition } from "react";
import { Clock, Loader2, PlayCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  rescanAction,
  runPipelineAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The two controls that should be reached for first.
 *
 * **Run the pipeline** does sync → validate → fingerprint → signatures → cluster in one
 * pass. The individual stage buttons below it still exist and are still the right tool for
 * tuning one threshold at a time — but running stages individually is exactly how the
 * derived data fell behind: fingerprints 1,566 short of the corpus and dedup signatures
 * 2,240, each gap widening with every sync. Neither shortfall raises an error. They look
 * like a smaller corpus, and they quietly starve archetype mining, which reads fingerprints
 * and only sees canonical skills.
 *
 * **Re-scan** covers the other drift. An analyzer version bump leaves every previously
 * judged skill carrying a verdict from the old rules; `structural-lint` went 1.0.0 → 1.3.0
 * in one session and left 4,179 behind. R2.12 asks for those to be re-judged within seven
 * days, which needs the number to be visible before it needs a button.
 */

export type FreshnessRow = {
  analyzer: string;
  currentVersion: string;
  total: number;
  behind: Array<{ version: string; count: number }>;
};

export type RunRow = {
  at: string;
  ok: boolean;
  trigger: string;
  elapsedMs: number | null;
  stages: Array<{ stage: string; ok: boolean; detail: string }>;
};

export type BacklogRow = {
  sourcesAwaitingSync: number;
  awaitingValidation: number;
  awaitingFingerprint: number;
  awaitingSignature: number;
};

export function PipelinePanel({
  freshness,
  backlog,
  runs,
  cronEnabled,
}: {
  freshness: FreshnessRow[];
  backlog: BacklogRow;
  runs: RunRow[];
  cronEnabled: boolean;
}) {
  const stale = freshness.reduce((sum, row) => sum + row.total, 0);

  // Full width, stacked: the pipeline card carries run-history lines that read as prose,
  // and half a row is not enough for them at any sidebar state.
  return (
    <div className="grid gap-4">
      <PipelineCard backlog={backlog} runs={runs} cronEnabled={cronEnabled} />

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <RefreshCw className="text-muted-foreground size-4" />
            Verdict freshness
            {stale > 0 ? (
              <Badge variant="outline" className="tabular-nums">
                {stale.toLocaleString()} stale
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Skills carrying a verdict from a superseded analyzer version. Their judgement
            was made by rules that have since changed, so it may no longer be the one those
            rules would reach today. Re-judging is free — no model is involved.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <ul className="grid gap-1.5">
            {freshness.map((row) => (
              <li
                key={row.analyzer}
                className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {row.analyzer.replace(/-/g, " ")}
                  <span className="text-muted-foreground ml-2 text-xs">
                    v{row.currentVersion}
                  </span>
                </span>
                <span
                  className={`shrink-0 tabular-nums text-xs ${
                    row.total > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
                  }`}
                >
                  {row.total > 0 ? `${row.total.toLocaleString()} stale` : "current"}
                </span>
              </li>
            ))}
          </ul>

          <RescanControl disabled={stale === 0} />
        </CardContent>
      </Card>
    </div>
  );
}

function RescanControl({ disabled }: { disabled: boolean }) {
  const [amount, setAmount] = useState(300);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const outcome = await rescanAction(amount);
      setResult(outcome);
      if (outcome.ok) toast.success("Re-scan", { description: outcome.message });
      else toast.error("Re-scan failed", { description: outcome.message });
    });
  }

  return (
    /* Separated from the list above, matching the pipeline card: the list is a report and
       the row below it is an action, and running them together read as one block. */
    <div className="grid gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={1}
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value) || 1)}
          aria-label="Versions to re-judge"
          className="border-input bg-background focus-visible:ring-ring h-9 w-24 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
        />
        <span className="text-muted-foreground text-sm">versions</span>
        <Button onClick={run} disabled={isPending || disabled} size="sm" className="ml-auto">
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Re-judge
        </Button>
      </div>
      <Result result={result} />
    </div>
  );
}

/**
 * The pipeline control, written so the number in it means something.
 *
 * "5 sources" on its own answers neither *five out of how many* nor *what changes if I
 * make it ten*, and the four stages that follow have no input at all — their slice sizes
 * are defaults an operator cannot see. So the card leads with the backlog: what each stage
 * would find to do right now, and how much of it this press would clear.
 *
 * Only the source count is adjustable, because it is the only one with a real trade-off.
 * Fetching is the slow, rate-limited, failure-prone stage; the rest read from the database
 * and object storage and are sized generously by default. Exposing five inputs would imply
 * five decisions where there is one.
 *
 * Capped at 10 because a pass is a single request: outrun the timeout and everything after
 * the current stage is lost, so the input must not offer a value that reliably fails.
 *
 * That reasoning lives here rather than under the control. The stage list already shows
 * what the number does — a paragraph explaining it as well was three sentences of prose
 * the operator has to read every time to learn nothing the table above did not show.
 */
function PipelineCard({
  backlog,
  runs,
  cronEnabled,
}: {
  backlog: BacklogRow;
  runs: RunRow[];
  cronEnabled: boolean;
}) {
  const [amount, setAmount] = useState(5);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const outstanding =
    backlog.sourcesAwaitingSync +
    backlog.awaitingValidation +
    backlog.awaitingFingerprint +
    backlog.awaitingSignature;

  function trigger() {
    startTransition(async () => {
      const outcome = await runPipelineAction(amount);
      setResult(outcome);
      if (outcome.ok) toast.success("Pipeline", { description: outcome.message });
      else toast.error("Pipeline", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlayCircle className="text-muted-foreground size-4" />
          Run the pipeline
        </CardTitle>
        <CardDescription>
          One bounded pass of every stage, in dependency order. Prefer this over the
          individual stages below — running those separately is how the derived data drifts
          behind the corpus, and a shortfall there looks like a smaller corpus rather than
          an error.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        <ol className="grid gap-1.5 text-sm">
          <Stage
            n={1}
            name="Sync"
            queue={backlog.sourcesAwaitingSync}
            unit="source"
            takes={Math.min(amount, backlog.sourcesAwaitingSync)}
            note="fetches skills from repositories never synced"
          />
          <Stage
            n={2}
            name="Validate"
            queue={backlog.awaitingValidation}
            unit="version"
            takes={Math.min(500, backlog.awaitingValidation)}
            note="runs the four rule-based analyzers"
          />
          <Stage
            n={3}
            name="Fingerprint"
            queue={backlog.awaitingFingerprint}
            unit="version"
            takes={Math.min(500, backlog.awaitingFingerprint)}
            note="extracts document structure for archetype mining"
          />
          <Stage
            n={4}
            name="Signatures"
            queue={backlog.awaitingSignature}
            unit="version"
            takes={Math.min(500, backlog.awaitingSignature)}
            note="MinHash, for near-duplicate detection"
          />
          <Stage
            n={5}
            name="Cluster"
            queue={null}
            unit=""
            takes={400}
            note="compares up to 400 candidate pairs and folds duplicates"
          />
        </ol>

        <div className="border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={1}
              max={10}
              value={amount}
              onChange={(event) =>
                setAmount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))
              }
              aria-label="Sources to sync this pass"
              className="border-input bg-background focus-visible:ring-ring h-9 w-20 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
            />
            <span className="text-muted-foreground text-sm">
              of {backlog.sourcesAwaitingSync.toLocaleString()} sources
            </span>
            <Button onClick={trigger} disabled={isPending} size="sm" className="ml-auto">
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PlayCircle className="size-4" />
              )}
              Run pipeline
            </Button>
          </div>

          {outstanding > 0 ? (
            <p className="text-muted-foreground mt-2 text-xs">
              {outstanding.toLocaleString()} items outstanding
              {cronEnabled ? " — the schedule is working through them." : "."}
            </p>
          ) : null}
        </div>

        {/*
          Schedule status and recent passes.

          A schedule you cannot observe is one you cannot trust: "it is running" and "it has
          been failing since Tuesday" look identical from outside. Each pass writes an
          `events` row, and this is that row rendered.
        */}
        <div className="border-t pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Clock className="text-muted-foreground size-4" />
            <span className="text-sm font-medium">Schedule</span>
            <Badge variant={cronEnabled ? "default" : "outline"}>
              {cronEnabled ? "every 10 minutes" : "not configured"}
            </Badge>
            {!cronEnabled ? (
              <span className="text-muted-foreground text-xs">
                set <code className="text-[11px]">CRON_SECRET</code> to enable
              </span>
            ) : null}
          </div>

          {runs.length > 0 ? (
            <ul className="mt-2 grid gap-1">
              {runs.slice(0, 5).map((run) => (
                <li
                  key={run.at}
                  className="flex flex-wrap items-baseline gap-x-2 text-xs"
                  title={run.stages.map((s) => `${s.stage}: ${s.detail}`).join("\n")}
                >
                  <span
                    className={
                      run.ok ? "text-muted-foreground" : "text-destructive font-medium"
                    }
                  >
                    {run.ok ? "✓" : "✗"}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(run.at).toLocaleString()}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {run.trigger}
                  </Badge>
                  {run.elapsedMs !== null ? (
                    <span className="text-muted-foreground tabular-nums">
                      {Math.round(run.elapsedMs / 1000)}s
                    </span>
                  ) : null}
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-right">
                    {run.stages.find((s) => s.stage === "sync")?.detail ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">
              No passes recorded yet.
            </p>
          )}
        </div>

        {isPending ? (
          <p className="text-muted-foreground text-xs">
            Running every stage in order — a minute or two.
          </p>
        ) : null}
        <Result result={result} />
      </CardContent>
    </Card>
  );
}

/** One row of the pipeline plan: what is queued, and how much this press would take. */
function Stage({
  n,
  name,
  queue,
  unit,
  takes,
  note,
}: {
  n: number;
  name: string;
  queue: number | null;
  unit: string;
  takes: number;
  note: string;
}) {
  const idle = queue !== null && queue === 0;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-muted-foreground tabular-nums text-xs">{n}</span>
      <span className={idle ? "text-muted-foreground" : "font-medium"}>{name}</span>
      <span className="text-muted-foreground text-xs">{note}</span>
      <span
        className={`ml-auto shrink-0 tabular-nums text-xs ${
          idle ? "text-muted-foreground" : ""
        }`}
      >
        {queue === null
          ? `up to ${takes}`
          : idle
            ? "nothing queued"
            : `${takes.toLocaleString()} of ${queue.toLocaleString()} ${unit}${queue === 1 ? "" : "s"}`}
      </span>
    </li>
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
