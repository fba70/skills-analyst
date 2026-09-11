"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, FlaskConical, ListChecks, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  acceptRuleCasesAction,
  createEvalAction,
  deleteEvalAction,
  runEvalsAction,
} from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatConversationSpend } from "@/lib/conversation";
import {
  EVAL_KIND_META,
  EVAL_KINDS,
  EVAL_SOURCE_LABEL,
  isRegression,
  isStale,
  summarise,
  type EvalCaseState,
  type EvalKind,
} from "@/lib/evals";
import { RULE_CASE_SKIP_MESSAGE, type RuleCaseReport } from "@/lib/rule-cases";

/**
 * Skill CI on a draft (Doc 2 R2.11, Doc 6 RW.6, plan step D1).
 *
 * ## What this panel is careful about
 *
 * Everything else on this page is a statement about *form* — the analyzers say the document is
 * well-formed, the archetype says its shape matches the corpus. This is the only panel that
 * claims the skill **works**, so its numbers have to be exactly as strong as the evidence.
 *
 * Three distinctions the UI keeps rather than flattening:
 *
 * - **Stale is not failing.** A result against an older document is not a result about this
 *   one. It is marked, and it does not count towards the summary's verdict.
 * - **Errored is not failing.** A refused call is a fact about us. Reading it as a defect would
 *   send an author looking for a bug in a document that is fine.
 * - **A regression is not any failure.** A case that never passed is a specification the skill
 *   does not yet meet, which is a legitimate thing to publish. A case that *used* to pass is a
 *   thing the skill has lost, and that is what blocks publication.
 *
 * ## Nothing runs on its own
 *
 * The run button is a button. The plan says every edit re-runs; that would bill a call per save
 * in a block-editing session, and the property it wanted — never showing a result for an older
 * document — is delivered by the staleness marks instead. Same posture as the similarity check.
 */

export function EvalPanel({
  draftId,
  cases,
  proposals,
  contentHash,
  entitled,
  canRun,
}: {
  draftId: string;
  cases: EvalCaseState[];
  /** What the draft's decision rules would test (Doc 7 RD.4). Null before any block exists. */
  proposals: RuleCaseReport | null;
  /** The document the results are compared against. */
  contentHash: string;
  /** Whether this workspace has the Eval Lab. Writing cases is free; running is not. */
  entitled: boolean;
  /** False before anything has been written — there is no document to test. */
  canRun: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<EvalKind>("should-trigger");
  const [prompt, setPrompt] = useState("");
  const [expectation, setExpectation] = useState("");

  const summary = summarise(cases, contentHash);

  function add() {
    startTransition(async () => {
      const result = await createEvalAction(draftId, kind, prompt, expectation);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setPrompt("");
      setExpectation("");
      setAdding(false);
      router.refresh();
    });
  }

  function accept(keys: string[]) {
    startTransition(async () => {
      const result = await acceptRuleCasesAction(draftId, keys);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const { created, missed } = result.data;
      toast.success(
        missed > 0
          ? `${created} case${created === 1 ? "" : "s"} added · ${missed} offer${
              missed === 1 ? "" : "s"
            } had already moved on`
          : `${created} case${created === 1 ? "" : "s"} added`,
      );
      router.refresh();
    });
  }

  function run() {
    startTransition(async () => {
      const result = await runEvalsAction(draftId);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      const { ran, passed, failed, errored, costMicros } = result.data;
      toast.success(
        ran === 0
          ? "Every case already has a result for this document."
          : `${ran} run · ${passed} passed · ${failed} failed${
              errored ? ` · ${errored} errored` : ""
            } · ${formatConversationSpend(costMicros)}`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FlaskConical className="size-4" />
          Evals
          {cases.length > 0 ? (
            <span className="text-muted-foreground text-xs font-normal tabular-nums">
              {summary.passed}/{summary.total} passing
              {summary.stale > 0 ? ` · ${summary.stale} stale` : ""}
              {summary.errored > 0 ? ` · ${summary.errored} errored` : ""}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>
          Everything else on this page says the document is well-formed. These say it works —
          whether an agent would reach for it, whether it stays out of nearby requests, and
          whether following it produces the right answer.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {summary.regressions > 0 ? (
          <div className="border-destructive/40 flex items-start gap-2 rounded-md border p-3">
            <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
            <p className="text-sm">
              {summary.regressions} case{summary.regressions === 1 ? "" : "s"} used to pass and
              no longer do. Publishing is blocked until that is fixed or the case is removed —
              a case that has <em>never</em> passed does not block anything.
            </p>
          </div>
        ) : null}

        {/*
          Offers from the decision rules (Doc 7 RD.4, plan step P6).

          Framed as an offer and never as a finding. Coverage below already says which cases the
          document leaves open; this says which of the cases it *does* make have nothing checking
          them, and an author is entitled to answer "none of them, thank you". So there is no
          warning colour, no count in the card title, and nothing here reaches the publish gate.

          The skipped rows are printed rather than dropped, because "my rules are still prose" and
          "every row already has a case" produce the same empty list and mean opposite things.
        */}
        {proposals && proposals.proposals.length > 0 ? (
          <div className="grid gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <ListChecks className="size-4" />
              <p className="text-sm font-medium">
                {proposals.proposals.length} rule
                {proposals.proposals.length === 1 ? "" : "s"} with no case yet
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="ml-auto"
                disabled={isPending}
                onClick={() => accept(proposals.proposals.map((p) => p.key))}
              >
                Add all
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              A row of a decision table is a golden task waiting to be accepted: the conditions
              frame the request, and your own action is what makes the answer right. Nothing is
              rewritten, and nothing is added until you say so.
            </p>
            <ul className="grid gap-2">
              {proposals.proposals.map((proposal) => (
                <li key={proposal.key} className="grid gap-1 border-t pt-2">
                  <div className="flex min-w-0 flex-wrap items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm">{proposal.prompt}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending}
                      onClick={() => accept([proposal.key])}
                    >
                      <Plus className="size-3.5" />
                      Add
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Right when: {proposal.expectation}
                  </p>
                </li>
              ))}
            </ul>
            {proposals.more > 0 ? (
              <p className="text-muted-foreground text-xs">
                {proposals.more} more after these. Accept a batch and the rest appear.
              </p>
            ) : null}
          </div>
        ) : null}

        {proposals && proposals.proposals.length === 0 && proposals.covered > 0 ? (
          <p className="text-muted-foreground text-xs">
            Every structured rule on this draft has a case. {proposals.covered} of them.
          </p>
        ) : null}

        {proposals && proposals.skipped.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            {proposals.skipped.length} row
            {proposals.skipped.length === 1 ? "" : "s"} propose nothing:{" "}
            {[...new Set(proposals.skipped.map((row) => RULE_CASE_SKIP_MESSAGE[row.reason]))].join(
              " ",
            )}
          </p>
        ) : null}

        {cases.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No cases yet. Two or three requests the skill should fire on, one it should stay out
            of, and a real task with its right answer is enough to catch most of what breaks.
          </p>
        ) : (
          <ul className="grid gap-2">
            {cases.map((testCase) => {
              const stale = isStale(testCase, contentHash);
              const regressed = isRegression(testCase);
              return (
                <li key={testCase.id} className="grid gap-1 rounded-md border p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="outline">{EVAL_KIND_META[testCase.kind].label}</Badge>
                    {testCase.latest === null ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        not run
                      </Badge>
                    ) : (
                      <Badge
                        variant={testCase.latest.verdict === "pass" ? "secondary" : "outline"}
                        className={
                          testCase.latest.verdict === "fail" ? "border-destructive/50" : undefined
                        }
                      >
                        {testCase.latest.verdict}
                      </Badge>
                    )}
                    {/*
                      Stale is its own mark rather than a greyed-out verdict. A result that
                      describes an older document is not a weaker claim about this one — it is
                      not a claim about this one at all.
                    */}
                    {stale && testCase.latest !== null ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        stale
                      </Badge>
                    ) : null}
                    {regressed ? (
                      <Badge variant="outline" className="border-destructive/50">
                        regression
                      </Badge>
                    ) : null}
                    {/*
                      Read from the vocabulary rather than compared against one of its values.
                      The panel showed "from an interview" and nothing else, so a third source
                      would have rendered as though the author had typed the case themselves.
                    */}
                    {testCase.source !== "authored" ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        {EVAL_SOURCE_LABEL[testCase.source].toLowerCase()}
                      </Badge>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="ml-auto size-7"
                      aria-label="Delete this case"
                      disabled={isPending}
                      onClick={() =>
                        startTransition(async () => {
                          await deleteEvalAction(draftId, testCase.id);
                          router.refresh();
                        })
                      }
                    >
                      <Trash2 className="text-destructive size-3.5" />
                    </Button>
                  </div>
                  <p className="text-sm">{testCase.prompt}</p>
                  {testCase.expectation ? (
                    <p className="text-muted-foreground text-xs">
                      Right when: {testCase.expectation}
                    </p>
                  ) : null}
                  {testCase.latest?.detail ? (
                    <p className="text-muted-foreground text-xs italic">
                      {testCase.latest.detail}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {adding ? (
          <div className="grid gap-2 rounded-md border p-3">
            <select
              aria-label="Case kind"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as EvalKind)}
            >
              {EVAL_KINDS.map((option) => (
                <option key={option} value={option}>
                  {EVAL_KIND_META[option].label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">{EVAL_KIND_META[kind].blurb}</p>
            <Input
              placeholder="The request, as somebody would actually phrase it"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {EVAL_KIND_META[kind].needsExpectation ? (
              <textarea
                className="border-input bg-background min-h-16 w-full resize-y rounded-md border p-2 text-sm"
                placeholder="What makes the right answer right — tightly enough to check"
                value={expectation}
                onChange={(e) => setExpectation(e.target.value)}
              />
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" disabled={isPending || !prompt.trim()} onClick={add}>
                Add case
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Add a case
            </Button>
            <Button
              size="sm"
              disabled={isPending || !canRun || cases.length === 0 || !entitled}
              onClick={run}
            >
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Run stale cases
            </Button>
            {/*
              The gate is stated where the button is, and it says what writing still gets you.
              A disabled control with no explanation is the thing people file support tickets
              about — and the free tier really does keep the notepad.
            */}
            <span className="text-muted-foreground text-xs">
              {!entitled
                ? "Running cases is part of the Eval Lab. Writing them is free, and the interview writes them for you."
                : cases.length === 0
                  ? "Add a case first."
                  : !canRun
                    ? "Write the draft first — there is nothing to test yet."
                    : "Costs a model call per stale case. Cases already judged against this document are skipped."}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
