"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, Loader2, Minimize2, X } from "lucide-react";
import { toast } from "sonner";

import { decideVariantAction, optimiseAction } from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTokens } from "@/lib/tokens";
import {
  MIN_SAVING_PERCENT,
  VARIANT_OUTCOME_LABEL,
  type VariantOutcome,
  type VariantReport,
} from "@/lib/variants";

/**
 * A cheaper version of the same skill, proven before it is offered (Doc 6 RW.9).
 *
 * ## The claim is the evidence, not the number
 *
 * "1.9K instead of 4.2K" is easy and worthless on its own. What makes this worth an author's
 * attention is that the shorter document has been run against their own eval cases and did the
 * same thing. So the outcome leads and the saving follows it — and a variant that broke a case
 * is shown as having broken it, named case by case, rather than being hidden or offered anyway
 * with a smaller number attached.
 *
 * ## `est.` everywhere, and here that is honest rather than a hedge
 *
 * The estimator is four characters to the token. That makes it a poor claim about somebody's
 * context window and a good one for **comparing two documents measured the same way**, which is
 * the only thing this panel does with it. A3 wrote that caveat; this is the caller it was for.
 */
export function OptimiserPanel({
  draftId,
  hasCases,
  currentTokens,
}: {
  draftId: string;
  /** Without cases there is nothing to verify against, and an unverified cut is not an offer. */
  hasCases: boolean;
  currentTokens: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<{
    report: VariantReport;
    offerable: boolean;
    variantId: string;
    removed: string;
    body: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  function propose() {
    startTransition(async () => {
      const result = await optimiseAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setState(result.data);
      router.refresh();
    });
  }

  function decide(accept: boolean) {
    if (!state) return;
    startTransition(async () => {
      const result = await decideVariantAction(draftId, state.variantId, accept);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(
        accept ? "Taken. The draft is now the compressed version." : "Variant discarded.",
      );
      setState(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Minimize2 className="size-4" />
          Activation cost
          <span className="text-muted-foreground text-xs font-normal tabular-nums">
            {formatTokens(currentTokens)} est. per activation
          </span>
        </CardTitle>
        <CardDescription>
          The whole document enters an agent&rsquo;s context every time the skill fires, so
          every word is paid for repeatedly. This proposes a shorter version and then runs your
          own eval cases against it — a cut that cannot be checked is not offered.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {state ? (
          <>
            <div className="grid gap-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    state.report.outcome === "regressed" || state.report.outcome === "unverified"
                      ? "outline"
                      : "secondary"
                  }
                >
                  {VARIANT_OUTCOME_LABEL[state.report.outcome as VariantOutcome]}
                </Badge>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatTokens(state.report.sourceTokens)} →{" "}
                  {formatTokens(state.report.variantTokens)} est.
                </span>
                <span className="ml-auto tabular-nums">
                  {state.report.savedPercent > 0 ? "−" : "+"}
                  {Math.abs(state.report.savedPercent)}%
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {state.report.compared} case
                {state.report.compared === 1 ? "" : "s"} compared on both versions
                {state.report.incomparable > 0
                  ? `, ${state.report.incomparable} could not be compared`
                  : ""}
                .
              </p>
              <p className="text-muted-foreground text-xs italic">{state.removed}</p>
            </div>

            {/*
              A regression is named case by case. "It broke something" without saying what is a
              result an author cannot act on, and the natural response to it is to try again —
              which spends money to learn the same thing.
            */}
            {state.report.regressions.length > 0 ? (
              <div className="border-destructive/40 grid gap-1 rounded-md border p-3">
                <p className="text-sm">
                  The shorter version fails {state.report.regressions.length} case
                  {state.report.regressions.length === 1 ? "" : "s"} the current one passes:
                </p>
                <ul className="text-muted-foreground grid gap-0.5 text-xs">
                  {state.report.regressions.map((row) => (
                    <li key={row.caseId}>{row.prompt}</li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  Something load-bearing was cut. Not offered.
                </p>
              </div>
            ) : null}

            {state.report.improvements.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                It also passes {state.report.improvements.length} case
                {state.report.improvements.length === 1 ? "" : "s"} the current version fails —
                worth reading before assuming that is a bonus, since it usually means the case
                was ambiguous.
              </p>
            ) : null}

            <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs leading-relaxed whitespace-pre-wrap">
              {state.body}
            </pre>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={isPending || !state.offerable} onClick={() => decide(true)}>
                <Check className="size-4" />
                Take it
              </Button>
              <Button size="sm" variant="ghost" disabled={isPending} onClick={() => decide(false)}>
                <X className="size-4" />
                Keep the current one
              </Button>
              {!state.offerable ? (
                <span className="text-muted-foreground text-xs">
                  {state.report.regressions.length > 0
                    ? "Not offered — it broke a case."
                    : state.report.compared === 0
                      ? "Not offered — nothing could be verified against."
                      : `Not offered — the saving is under ${MIN_SAVING_PERCENT}%, which is inside the estimator's own error.`}
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || !hasCases}
            onClick={propose}
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Minimize2 className="size-4" />
            )}
            Propose a shorter version
          </Button>
          <span className="text-muted-foreground text-xs">
            {hasCases
              ? "One rewrite, then your eval cases run against it."
              : "Add an eval case first — a shorter document nobody checked is not an improvement."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
