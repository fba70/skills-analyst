"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { GitCompare, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { runMatrixAction } from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatConversationSpend } from "@/lib/conversation";
import {
  CALLS_PER_TASK,
  formatDelta,
  MIN_MATRIX_TASKS,
  type MatrixReport,
} from "@/lib/matrix";

/**
 * Does this skill actually help (Doc 6 RW.7, plan step D3).
 *
 * ## The number this panel exists for can be negative
 *
 * Every other surface in the builder measures whether the document is good. This one measures
 * whether it makes any difference, and the honest answer is sometimes no — or worse than no.
 * Nothing here clamps at zero or renders a negative as "no measurable improvement": a skill
 * that makes results worse is the finding the whole milestone is for, and it is the one an
 * author is least likely to go looking for.
 *
 * ## Per model, not just overall
 *
 * A skill that lifts a cheap model to a capable one's baseline is a real result and a
 * *different* result from one that lifts both. Showing only the average would report those two
 * identically, so the per-model rows are the primary reading and the mean is the summary.
 */
export function MatrixPanel({
  draftId,
  goldenTasks,
  published,
}: {
  draftId: string;
  goldenTasks: number;
  /** Only a published skill can carry the `eval-delta` signal — see the runner. */
  published: boolean;
}) {
  const router = useRouter();
  const [report, setReport] = useState<MatrixReport | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await runMatrixAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setReport(result.data);
      toast.success(
        result.data.costMicros > 0
          ? `Measured. ${formatConversationSpend(result.data.costMicros)}.`
          : "Every cell already had a result for this document.",
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="size-4" />
          Does it help?
        </CardTitle>
        <CardDescription>
          Every golden task run four ways — with the skill and without it, across two models. A
          skill can pass all its own tasks and still add nothing a capable model would not have
          done unaided. This is the only measurement here that can tell the difference.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {report === null ? (
          <p className="text-muted-foreground text-sm">
            {goldenTasks} golden task{goldenTasks === 1 ? "" : "s"} to measure.
          </p>
        ) : (
          <>
            <div className="grid gap-1 rounded-md border p-3">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">Overall</span>
                <span className="ml-auto text-lg tabular-nums">
                  {formatDelta(report.overallDelta) ?? (
                    <span className="text-muted-foreground text-sm">not measured</span>
                  )}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {report.completeTasks} task{report.completeTasks === 1 ? "" : "s"} measured in
                all four cells
                {report.incompleteTasks > 0
                  ? `, ${report.incompleteTasks} excluded for missing a cell`
                  : ""}
                .
              </p>
            </div>

            <ul className="grid gap-2">
              {report.perModel.map((row) => (
                <li
                  key={row.model}
                  className="flex min-w-0 flex-wrap items-baseline gap-2 rounded-md border p-3 text-sm"
                >
                  <code className="min-w-0 truncate text-xs">{row.model}</code>
                  <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                    {row.withoutRate === null ? "—" : `${Math.round(row.withoutRate * 100)}%`}
                    {" → "}
                    {row.withRate === null ? "—" : `${Math.round(row.withRate * 100)}%`}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatDelta(row.delta) ?? (
                      <span className="text-muted-foreground text-xs">not measured</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>

            {report.thin ? (
              <p className="text-muted-foreground text-xs">
                Fewer than {MIN_MATRIX_TASKS} complete tasks. A delta from this few is one
                task&rsquo;s result rendered as a percentage.
              </p>
            ) : null}

            {report.overallDelta !== null && report.overallDelta <= 0 ? (
              <p className="text-sm">
                On these tasks the skill did not improve the result. That is worth knowing
                before publishing it — either the tasks do not exercise what the skill knows, or
                the models already knew it.
              </p>
            ) : null}

            {/*
              Whether a signal was written is stated rather than implied. It is the difference
              between a measurement that stays in this workspace and one that will eventually
              inform what the platform says good looks like (R6.3).
            */}
            <p className="text-muted-foreground border-t pt-3 text-xs">
              {report.recorded
                ? "Recorded as an impact signal against the published skill."
                : published
                  ? "No signal recorded — there was no complete measurement to attach."
                  : "Publish the skill to record this as an impact signal; a draft has no version to attach one to."}
            </p>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={isPending || goldenTasks === 0} onClick={run}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <GitCompare className="size-4" />
            )}
            Measure
          </Button>
          <Badge variant="outline" className="text-muted-foreground font-normal">
            up to {goldenTasks * CALLS_PER_TASK} model calls
          </Badge>
          <span className="text-muted-foreground text-xs">
            {goldenTasks === 0
              ? "Add a golden task above first — trigger probes cannot measure impact."
              : "Cells already measured against this document are skipped."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
