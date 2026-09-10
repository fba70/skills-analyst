"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  addRuleAction,
  consistencyAction,
  declareParameterAction,
  decideParameterAction,
  decideRuleAction,
  deleteParameterAction,
  detectParametersAction,
  makeTableAction,
  type ConsistencyResult,
} from "@/app/(protected)/build/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  PARAMETER_KIND_META,
  PARAMETER_KINDS,
  RULE_STATE_META,
  type CoverageReport,
  type Parameter,
  type ParameterKind,
  type RuleState,
} from "@/lib/parameters";

/**
 * Parameters, structured rules, coverage and consistency on a draft (Doc 7 RD.1–RD.3).
 *
 * ## Written so it cannot become a checklist
 *
 * Coverage below 100% is a list of cases with an *add a rule here* beside each — an empty row,
 * never anybody's action — and a sentence saying a skill may leave a case to the agent. Nothing
 * here blocks anything; publishing is gated on the analyzers (R4.5) and on nothing on this card.
 *
 * ## Two zeros, told apart
 *
 * A parameter with no measurable values says *not measurable*, not *0%*. A draft with no
 * decision rules says what was looked for. An empty parameter list says how to fill it. Each empty
 * state is a different sentence, because each is a different fact.
 *
 * ## The two buttons that cost money say so
 *
 * Detection and the consistency check each call a small model, metered to the workspace. They are
 * buttons, not autocomplete — the `findSimilarAction` posture — and the copy beside them says what
 * each call reads.
 */

export type PanelParameter = Parameter & { id: string; source: string; decision: string };

export type PanelRule = {
  blockId: string;
  order: number;
  state: RuleState;
  excerpt: string;
  rows: number;
  parameters: string[];
};

const STATE_VARIANT: Record<RuleState, "outline" | "secondary" | "default" | "destructive"> = {
  none: "outline",
  candidate: "secondary",
  "in-step": "default",
  detached: "destructive",
};

export function ParametersPanel({
  draftId,
  parameters,
  rules,
  coverage,
  disabled,
}: {
  draftId: string;
  parameters: PanelParameter[];
  rules: PanelRule[];
  coverage: CoverageReport;
  disabled: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ParameterKind>("enum");
  const [values, setValues] = useState("");
  const [meaning, setMeaning] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [consistency, setConsistency] = useState<ConsistencyResult | null>(null);

  const accepted = parameters.filter((p) => p.decision === "accepted");
  const pending = parameters.filter((p) => p.decision === "pending");
  const candidates = rules.filter((r) => r.state === "candidate");
  const inStep = rules.filter((r) => r.state === "in-step");
  const firstTable = inStep.find((r) => r.rows > 1) ?? inStep[0] ?? null;

  function run(work: () => Promise<{ ok: boolean; message?: string; data?: { message?: string } }>) {
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        toast.error(result.message ?? "That did not work.");
        return;
      }
      if (result.data?.message) toast.success(result.data.message);
      router.refresh();
    });
  }

  const busy = disabled || isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Parameters and decision rules</CardTitle>
        <CardDescription>
          What this skill branches on, and whether every case has a rule. Coverage is arithmetic
          over the rules you have confirmed; it changes nothing and blocks nothing — a skill may
          leave a case to the agent on purpose.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        {/* ------------------------------------------------------------ parameters */}
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Parameters</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => detectParametersAction(draftId))}
            >
              Detect from decision rules
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Detection reads each decision-rule block once with a small model and proposes what it
            branches on. One metered call per block, against your workspace cap. Everything it
            proposes waits for you.
          </p>

          {accepted.length === 0 && pending.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No parameters yet. Detect them from the draft&apos;s decision rules, or declare one
              below. A skill with none is a valid skill.
            </p>
          ) : null}

          {pending.length > 0 ? (
            <ul className="grid gap-2">
              {pending.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-sm">
                  <Badge variant="secondary">suggested</Badge>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {PARAMETER_KIND_META[p.kind].label.toLowerCase()}
                    {p.values.length ? ` · ${p.values.join(", ")}` : ""}
                  </span>
                  {p.meaning ? <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{p.meaning}</span> : null}
                  <div className="ml-auto flex gap-1">
                    <Button type="button" size="sm" disabled={busy} onClick={() => run(() => decideParameterAction(draftId, p.id, "accepted"))}>
                      Accept
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => decideParameterAction(draftId, p.id, "rejected"))}>
                      Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {accepted.length > 0 ? (
            <ul className="grid gap-1">
              {accepted.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{p.name}</span>
                  <Badge variant="outline" className="text-[11px]">{PARAMETER_KIND_META[p.kind].label}</Badge>
                  {p.kind === "enum" ? (
                    <span className="text-muted-foreground min-w-0 truncate text-xs">{p.values.join(" · ")}</span>
                  ) : null}
                  {p.source !== "declared" ? (
                    <span className="text-muted-foreground text-[11px]">{p.source}</span>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={busy}
                    onClick={() => run(() => deleteParameterAction(draftId, p.id))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          <form
            className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const result = await declareParameterAction(draftId, { name, kind, values, unit: "", meaning });
                if (result.ok) {
                  setName("");
                  setValues("");
                  setMeaning("");
                }
                return result.ok ? { ok: true, data: { message: "Declared." } } : result;
              });
            }}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <Input placeholder="Name — environment" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              <select
                className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value as ParameterKind)}
                disabled={busy}
                aria-label="Kind"
              >
                {PARAMETER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PARAMETER_KIND_META[k].label}
                  </option>
                ))}
              </select>
              <Input
                placeholder={kind === "enum" ? "Values — prod, staging, dev" : "Meaning"}
                value={kind === "enum" ? values : meaning}
                onChange={(e) => (kind === "enum" ? setValues(e.target.value) : setMeaning(e.target.value))}
                disabled={busy}
              />
            </div>
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              Declare
            </Button>
          </form>
        </section>

        {/* ------------------------------------------------------------ rules */}
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Decision rules</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || selected.length < 2}
              onClick={() => run(() => makeTableAction(draftId, selected).then((r) => (r.ok ? (setSelected([]), r) : r)))}
            >
              Make {selected.length >= 2 ? `these ${selected.length}` : "selected"} a table
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No block on this draft is typed as a decision rule. Type one in the editor and detect
              its parameters; coverage needs a rule to count.
            </p>
          ) : (
            <ul className="grid gap-2">
              {rules.map((r) => (
                <li key={r.blockId} className="grid gap-1 rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    {r.state === "in-step" ? (
                      <input
                        type="checkbox"
                        aria-label="Select for a table"
                        checked={selected.includes(r.blockId)}
                        disabled={busy}
                        onChange={(e) =>
                          setSelected((s) => (e.target.checked ? [...s, r.blockId] : s.filter((id) => id !== r.blockId)))
                        }
                      />
                    ) : null}
                    <Badge variant={STATE_VARIANT[r.state]} className="text-[11px]">
                      {RULE_STATE_META[r.state].label}
                    </Badge>
                    <span className="text-muted-foreground text-xs">block {r.order + 1}</span>
                    {r.parameters.length ? (
                      <span className="text-muted-foreground text-xs">branches on {r.parameters.join(", ")}</span>
                    ) : null}
                    {r.state === "candidate" ? (
                      <div className="ml-auto flex gap-1">
                        <Button type="button" size="sm" disabled={busy} onClick={() => run(() => decideRuleAction(draftId, r.blockId, "confirm"))}>
                          Confirm structure
                        </Button>
                        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(() => decideRuleAction(draftId, r.blockId, "reject"))}>
                          Keep as prose
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground min-w-0 truncate text-xs">{r.excerpt}</p>
                  {r.state === "detached" ? (
                    <p className="text-muted-foreground text-xs">{RULE_STATE_META.detached.blurb}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {candidates.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {candidates.length} suggested structure{candidates.length === 1 ? "" : "s"} waiting.
              Nothing counts towards coverage until you confirm it.
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------------------ coverage */}
        <section className="grid gap-3">
          <h3 className="text-sm font-medium">Coverage of the case space</h3>
          {coverage.parameters.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing to measure until a parameter is declared.</p>
          ) : (
            <ul className="grid gap-2">
              {coverage.parameters.map((c) => (
                <li key={c.name} className="grid gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.measurable ? (
                      <span className="tabular-nums">
                        {c.covered} of {c.declared} values · {c.share}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        not measurable — {PARAMETER_KIND_META[c.kind].label.toLowerCase()}
                      </span>
                    )}
                    {c.rows === 0 ? <Badge variant="outline" className="text-[11px]">unused</Badge> : null}
                  </div>
                  {c.missing.length > 0 ? (
                    <ul className="flex flex-wrap gap-1">
                      {c.missing.map((value) => (
                        <li key={value}>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => run(() => addRuleAction(draftId, c.name, value, firstTable?.blockId ?? null))}
                          >
                            no rule for {c.name} = {value} — add one
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {coverage.joint.length > 0 ? (
            <ul className="text-muted-foreground grid gap-0.5 text-xs">
              {coverage.joint.map((j) => (
                <li key={j.parameters.join("×")}>
                  {j.parameters[0]} × {j.parameters[1]}: {j.covered} of {j.combinations} combinations ({j.share}%)
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Only confirmed, in-step rules count. An <em>otherwise</em> row closes a parameter&apos;s
            case space. &ldquo;Add one&rdquo; puts an empty rule in the draft with the condition
            filled in and the action left to you.
          </p>
        </section>

        {/* ------------------------------------------------------------ consistency */}
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Consistency</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || inStep.length < 2}
              onClick={() =>
                startTransition(async () => {
                  const result = await consistencyAction(draftId);
                  if (!result.ok) {
                    toast.error(result.message);
                    return;
                  }
                  setConsistency(result.data);
                })
              }
            >
              Check for contradictions
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Pairs of confirmed rules that can both fire and share a parameter, each judged once by a
            small model: is there any one action that satisfies both? One metered call per pair.
            Rules on different parameters are not compared.
          </p>
          {consistency ? (
            consistency.pairsConsidered === 0 ? (
              <p className="text-sm">No two confirmed rules can fire together on a shared parameter. Nothing to compare.</p>
            ) : consistency.conflicts.length === 0 ? (
              <p className="text-sm">
                {consistency.pairsAsked} of {consistency.pairsConsidered} pairs checked, none contradict.
                {consistency.stopped ? " Stopped early — the workspace budget refused." : ""}
              </p>
            ) : (
              <ul className="grid gap-2">
                {consistency.conflicts.map((f, i) => (
                  <li key={i} className="border-destructive/40 grid gap-1 rounded-md border p-2 text-sm">
                    <p>
                      <span className="font-medium">&ldquo;{f.a.text}&rdquo;</span> against{" "}
                      <span className="font-medium">&ldquo;{f.b.text}&rdquo;</span>
                    </p>
                    <p className="text-muted-foreground text-xs">{f.why}</p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
