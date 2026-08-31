"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Play, X } from "lucide-react";
import { toast } from "sonner";

import {
  classifySampleAction,
  reviewCategoryAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { labelFor, REVIEW_FLOOR, type CategoryAxis } from "@/server/taxonomy/vocabulary";

/**
 * Categorisation: run a sample, then judge what came back.
 *
 * The panel is built around the loop the taxonomy actually needs, which is not "classify
 * everything and move on". It is: label a small sample, read the labels, notice where the
 * vocabulary is ambiguous, change a category description, run the sample again. So the
 * run control is a *sample size* with a low default, sitting next to the queue of
 * assignments the classifier was not sure about.
 *
 * `vocabulary.ts` is a leaf module of constants with no server imports, so importing
 * `labelFor` into a client component is safe — nothing behind it reaches the database.
 */

export type CoverageRow = {
  axis: CategoryAxis;
  value: string;
  total: number;
  confident: number;
  avgConfidence: number;
};

export type QueueRow = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  axis: CategoryAxis;
  value: string;
  confidence: number;
  rationale: string | null;
};

export type TaxonomyPanelProps = {
  coverage: CoverageRow[];
  queue: QueueRow[];
  /** How deep the queue actually is. The page shows one slice of it. */
  queueTotal: number;
  totals: { assignments: number; skillsLabelled: number; held: number; reviewed: number };
  remaining: number;
  /** Indexed skills with no description to classify. Never queued, never paid for. */
  notClassifiable: number;
  archetypeThreshold: number;
  maxBatch: number;
};

const STRATEGIES = [
  { key: "diverse", label: "Spread across corpus" },
  { key: "top-quality", label: "Highest quality first" },
  { key: "recent", label: "Most recently synced" },
] as const;

export function TaxonomyPanel(props: TaxonomyPanelProps) {
  const {
    coverage,
    queue,
    queueTotal,
    totals,
    remaining,
    notClassifiable,
    archetypeThreshold,
    maxBatch,
  } = props;
  const functions = coverage.filter((row) => row.axis === "function");
  const domains = coverage.filter((row) => row.axis === "domain");
  const ready = functions.filter((row) => row.confident >= archetypeThreshold).length;

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">
        Two axes. <strong>Function</strong> is what a skill does, and it is the axis
        archetypes are mined on, because structure follows function — a skill that reviews
        a contract and one that reviews a pull request share a shape.{" "}
        <strong>Domain</strong> is the field it serves, and it drives browse and filter.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Skills labelled"
          value={totals.skillsLabelled}
          /*
           * `remaining` excludes skills with no description, so it can actually reach zero.
           * They are reported beside it rather than folded in — one number is work left,
           * the other is a fact about the corpus, and adding them together would make the
           * taxonomy look permanently unfinished.
           */
          detail={
            notClassifiable > 0
              ? `${remaining} to go · ${notClassifiable} with no description`
              : `${remaining} to go`
          }
        />
        <Stat label="Assignments" value={totals.assignments} />
        <Stat
          label="Held for review"
          value={totals.held}
          detail={`confidence below ${REVIEW_FLOOR}`}
        />
        <Stat
          label="Archetype-ready"
          value={ready}
          detail={`functions at ${archetypeThreshold}+ skills`}
        />
      </div>

      <RunCard maxBatch={maxBatch} />

      <div className="grid gap-4 lg:grid-cols-2">
        <CoverageCard
          title="Function"
          description="Mined for archetypes. A function needs enough skills before its archetype means anything."
          axis="function"
          rows={functions}
          threshold={archetypeThreshold}
        />
        <CoverageCard
          title="Domain"
          description="Drives browse and filter. No structural claim hangs off these."
          axis="domain"
          rows={domains}
        />
      </div>

      <ReviewQueue queue={queue} total={queueTotal} />
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1 py-4">
        <span className="text-muted-foreground text-xs">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}

function RunCard({ maxBatch }: { maxBatch: number }) {
  const [size, setSize] = useState(20);
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]["key"]>("diverse");
  const [result, setResult] = useState<ActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const outcome = await classifySampleAction(size, strategy);
      setResult(outcome);
      if (outcome.ok) toast.success("Classified", { description: outcome.message });
      else toast.error("Classification failed", { description: outcome.message });
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Classify a sample</CardTitle>
        <CardDescription>
          This is the only control here that calls a model, so it costs money per skill.
          Run a small sample, read what came back, adjust the category descriptions in{" "}
          <code className="text-xs">vocabulary.ts</code>, run it again. Capped at {maxBatch}{" "}
          per run.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={maxBatch}
            value={size}
            onChange={(event) => setSize(Number(event.target.value) || 1)}
            aria-label="Sample size"
            className="border-input bg-background focus-visible:ring-ring h-9 w-20 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
          />
          <span className="text-muted-foreground text-sm">skills</span>

          <select
            value={strategy}
            onChange={(event) =>
              setStrategy(event.target.value as (typeof STRATEGIES)[number]["key"])
            }
            aria-label="Sampling strategy"
            className="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2"
          >
            {STRATEGIES.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>

          <Button onClick={run} disabled={isPending} size="sm" className="ml-auto">
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Classify
          </Button>
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

function CoverageCard({
  title,
  description,
  axis,
  rows,
  threshold,
}: {
  title: string;
  description: string;
  axis: CategoryAxis;
  rows: CoverageRow[];
  threshold?: number;
}) {
  const max = Math.max(1, ...rows.map((row) => row.confident));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing classified yet. Run a sample above.
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => (
              <li key={row.value} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate">{labelFor(axis, row.value)}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums text-xs">
                    {row.confident}
                    {threshold && row.confident >= threshold ? " ✓" : ""}
                  </span>
                </div>
                <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full"
                    style={{ width: `${(row.confident / max) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The queue, with its depth stated on the card.
 *
 * The count is not decoration. Deciding a row deletes or pins it, the page revalidates, and
 * the next-worst row slides into the freed slot — so the list comes back exactly as long as
 * it was. Without a total beside it, every correct decision looked like it had been undone,
 * and the only honest signal ("Held for review") was four cards further up.
 */
function ReviewQueue({ queue, total }: { queue: QueueRow[]; total: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
          Low-confidence queue
          <span className="text-muted-foreground text-xs font-normal tabular-nums">
            showing {queue.length} of {total.toLocaleString()}
          </span>
        </CardTitle>
        <CardDescription>
          Assignments the classifier was unsure about, worst first. Confirming pins the
          category so a later re-run cannot overwrite it; removing deletes it, because a
          rejected category is one the skill does not have, not one we are unsure about.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {queue.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {total === 0
              ? "Nothing waiting. Every assignment cleared the confidence floor."
              : "Nothing on this page — the rows here have been decided. Go back a page."}
          </p>
        ) : (
          <ul className="grid gap-3">
            {queue.map((row) => (
              <QueueItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One held assignment.
 *
 * There is no "decided" state kept here, deliberately. An earlier version greyed the row
 * out on success — but the same action revalidates the page, the server returns a queue
 * that no longer contains this row, and the component unmounts a moment later. The grey
 * flashed and vanished while the list refilled from the backlog, which read as the decision
 * being undone rather than applied.
 *
 * The truthful signals are the ones that survive the refresh: the row is gone, the toast
 * says what happened, and the count on the card header goes down.
 */
function QueueItem({ row }: { row: QueueRow }) {
  const [isPending, startTransition] = useTransition();

  function decide(decision: "confirm" | "reject") {
    startTransition(async () => {
      const outcome = await reviewCategoryAction(row.id, decision);
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
    });
  }

  return (
    <li
      className={`border-border grid gap-2 rounded-md border p-3 transition-opacity ${
        isPending ? "opacity-50" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="tabular-nums">
          {row.confidence}
        </Badge>
        <span className="text-sm font-medium">{labelFor(row.axis, row.value)}</span>
        <span className="text-muted-foreground text-xs">{row.axis}</span>
        <span className="text-muted-foreground ml-auto truncate text-xs">{row.slug}</span>
      </div>

      {row.summary ? (
        <p className="text-muted-foreground line-clamp-2 text-xs">{row.summary}</p>
      ) : null}
      {row.rationale ? (
        <p className="text-muted-foreground text-xs italic">{row.rationale}</p>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => decide("confirm")}
        >
          {isPending ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => decide("reject")}
        >
          <X className="size-3" />
          Remove
        </Button>
      </div>
    </li>
  );
}
