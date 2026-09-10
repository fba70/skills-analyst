import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { generateText, Output } from "ai";
import { z } from "zod";

import {
  buildRule,
  coverage,
  confirmRuleFor,
  foldName,
  isParameterDecision,
  isParameterKind,
  isParameterSource,
  isParametersTable,
  MAX_CONSISTENCY_PAIRS,
  MAX_PARAMETER_NAME,
  MAX_PARAMETER_VALUES,
  MAX_PARAMETERS,
  MAX_RULE_ROWS,
  mayCoHold,
  renderParametersTable,
  renderRule,
  RULE_OPERATORS,
  ruleParameters,
  ruleState,
  type BlockRule,
  type CoverageReport,
  type Parameter,
  type ParameterDecision,
  type ParameterKind,
  type ParameterRefusal,
  type ParameterSource,
  type RuleRow,
  type RuleState,
} from "@/lib/parameters";
import type { DraftBlockInput } from "@/lib/draft-blocks";
import { assertWithinBudget, recordUsage } from "@/server/billing/spend";
import { getDraftBlocks, setDraftBlocks } from "@/server/builder/blocks";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { draftBlocks, draftParameters, events } from "@/server/db/schema";

/**
 * Parameters and decision rules on a draft (Doc 7 RD.1–RD.3, plan step P4).
 *
 * The reasoning is in `src/lib/parameters.ts`. What this module adds is the writes, and three
 * rules about them:
 *
 * - **Text changes go through `setDraftBlocks`.** A table made from three sentences, a row added
 *   for an uncovered case, the Parameters glossary written into the body — each renders the
 *   document through the one writer and lands in the revision history under `parameters`.
 * - **Structure-only changes do not.** Confirming or rejecting a candidate changes `rule` and
 *   nothing the reader sees; the body is a render of the *text*, which did not move. Routing that
 *   through the writer would re-validate a document nobody changed and write no revision anyway,
 *   so it is a direct update of the one column — stated here so the next reader does not take it
 *   for a second writer of the body.
 * - **Nothing here gates anything.** Coverage is a finding on the page. `publishDraft` does not
 *   import this module, and `verify:parameters` asserts it does not.
 */

export type ParameterResult<T> = { ok: true; data: T } | { ok: false; refusal: ParameterRefusal };

export type DraftParameter = Parameter & {
  id: string;
  source: ParameterSource;
  decision: ParameterDecision;
};

export async function listParameters(draftId: string, orgId: string): Promise<DraftParameter[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(draftParameters)
      .where(eq(draftParameters.draftId, draftId))
      .orderBy(asc(draftParameters.createdAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: isParameterKind(row.kind) ? row.kind : "free",
      values: Array.isArray(row.values) ? (row.values as string[]) : [],
      unit: row.unit,
      meaning: row.meaning,
      source: isParameterSource(row.source) ? row.source : "declared",
      decision: isParameterDecision(row.decision) ? row.decision : "accepted",
    }));
  });
}

type ParameterInput = {
  name: string;
  kind: ParameterKind;
  values?: string[];
  unit?: string | null;
  meaning?: string | null;
};

function cleanValues(kind: ParameterKind, values: string[] | undefined): string[] {
  if (kind !== "enum") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    const v = raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

/** Declare a parameter by hand. Accepted on arrival — the author typed it. */
export async function declareParameter(input: {
  orgId: string;
  userId: string;
  draftId: string;
  parameter: ParameterInput;
}): Promise<ParameterResult<{ id: string }>> {
  const name = input.parameter.name.trim().slice(0, MAX_PARAMETER_NAME);
  if (!name) return { ok: false, refusal: "empty" };
  const values = cleanValues(input.parameter.kind, input.parameter.values);
  /*
   * An enum with no values has nothing to measure coverage against, and "not measurable" is a
   * different sentence from "0%". Refused with the sentence rather than stored as a promise.
   */
  if (input.parameter.kind === "enum" && values.length === 0)
    return { ok: false, refusal: "enum-without-values" };
  if (values.length > MAX_PARAMETER_VALUES) return { ok: false, refusal: "too-many-values" };

  const result = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(draftParameters)
      .where(eq(draftParameters.draftId, input.draftId));
    if (count >= MAX_PARAMETERS) return { ok: false as const, refusal: "too-many-parameters" as const };

    const rows = await tx
      .insert(draftParameters)
      .values({
        orgId: input.orgId,
        draftId: input.draftId,
        name,
        kind: input.parameter.kind,
        values,
        unit: input.parameter.unit?.trim() || null,
        meaning: input.parameter.meaning?.trim() || null,
        source: "declared",
        decision: "accepted",
        createdBy: input.userId,
      })
      /* The folded unique index decides. Two spellings of one parameter is one parameter. */
      .onConflictDoNothing()
      .returning({ id: draftParameters.id });
    if (rows.length === 0) return { ok: false as const, refusal: "duplicate-name" as const };
    return { ok: true as const, data: { id: rows[0].id } };
  });

  if (result.ok) await syncParametersTable(input.draftId, input.orgId, input.userId);
  return result;
}

export async function updateParameter(input: {
  orgId: string;
  userId: string;
  draftId: string;
  id: string;
  parameter: ParameterInput;
}): Promise<ParameterResult<{ id: string }>> {
  const name = input.parameter.name.trim().slice(0, MAX_PARAMETER_NAME);
  if (!name) return { ok: false, refusal: "empty" };
  const values = cleanValues(input.parameter.kind, input.parameter.values);
  if (input.parameter.kind === "enum" && values.length === 0)
    return { ok: false, refusal: "enum-without-values" };
  if (values.length > MAX_PARAMETER_VALUES) return { ok: false, refusal: "too-many-values" };

  const result = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [clash] = await tx
      .select({ id: draftParameters.id })
      .from(draftParameters)
      .where(
        and(
          eq(draftParameters.draftId, input.draftId),
          sql`lower(${draftParameters.name}) = lower(${name})`,
          sql`${draftParameters.id} <> ${input.id}::uuid`,
        ),
      )
      .limit(1);
    if (clash) return { ok: false as const, refusal: "duplicate-name" as const };

    const rows = await tx
      .update(draftParameters)
      .set({
        name,
        kind: input.parameter.kind,
        values,
        unit: input.parameter.unit?.trim() || null,
        meaning: input.parameter.meaning?.trim() || null,
        updatedAt: new Date(),
      })
      .where(and(eq(draftParameters.id, input.id), eq(draftParameters.draftId, input.draftId)))
      .returning({ id: draftParameters.id });
    if (rows.length === 0) return { ok: false as const, refusal: "not-found" as const };
    return { ok: true as const, data: { id: rows[0].id } };
  });

  if (result.ok) await syncParametersTable(input.draftId, input.orgId, input.userId);
  return result;
}

/**
 * Remove a parameter. **The rules that named it stay.** A structured row references a parameter by
 * name, so deleting the declaration leaves the rule as a sentence about a word — coverage simply
 * stops measuring it. Deleting the author's rules because a glossary entry went would be the
 * cascade `campaign_topics` refused for the same reason.
 */
export async function deleteParameter(input: {
  orgId: string;
  userId: string;
  draftId: string;
  id: string;
}): Promise<ParameterResult<{ id: string }>> {
  const result = await withExplicitOrgScope(input.orgId, async (tx) => {
    const rows = await tx
      .delete(draftParameters)
      .where(and(eq(draftParameters.id, input.id), eq(draftParameters.draftId, input.draftId)))
      .returning({ id: draftParameters.id });
    if (rows.length === 0) return { ok: false as const, refusal: "not-found" as const };
    return { ok: true as const, data: { id: rows[0].id } };
  });
  if (result.ok) await syncParametersTable(input.draftId, input.orgId, input.userId);
  return result;
}

/** Accept or reject a detected candidate. A rejected one is kept, with its decision. */
export async function decideParameter(input: {
  orgId: string;
  userId: string;
  draftId: string;
  id: string;
  decision: "accepted" | "rejected";
}): Promise<ParameterResult<{ id: string }>> {
  const result = await withExplicitOrgScope(input.orgId, async (tx) => {
    const rows = await tx
      .update(draftParameters)
      .set({ decision: input.decision, updatedAt: new Date() })
      .where(and(eq(draftParameters.id, input.id), eq(draftParameters.draftId, input.draftId)))
      .returning({ id: draftParameters.id });
    if (rows.length === 0) return { ok: false as const, refusal: "not-found" as const };
    return { ok: true as const, data: { id: rows[0].id } };
  });
  if (result.ok) await syncParametersTable(input.draftId, input.orgId, input.userId);
  return result;
}

/**
 * The Parameters glossary table in the body, kept in step with the accepted parameters.
 *
 * Through `setDraftBlocks` like every other change to a document, so the body keeps its one
 * writer and the change lands in the revision history under its own reason. The table block is
 * recognised by its header line, keeps whatever position the author moved it to, and is removed
 * when the last parameter goes. A first table arrives under its own `## Parameters` heading at the
 * end of the draft — appended, never placed, for the reason an interview block is: the author
 * knows where it goes and a drag is one gesture away.
 */
export async function syncParametersTable(
  draftId: string,
  orgId: string,
  userId: string | null,
): Promise<{ changed: boolean }> {
  const [parameters, blocks] = await Promise.all([
    listParameters(draftId, orgId),
    getDraftBlocks(draftId, orgId),
  ]);
  const table = renderParametersTable(parameters);
  const existing = blocks.findIndex((b) => b.form === "content" && isParametersTable(b.text));

  if (existing === -1 && !table) return { changed: false };
  if (existing !== -1 && blocks[existing].text === table) return { changed: false };

  const carry = (b: (typeof blocks)[number]): DraftBlockInput => ({
    id: b.id,
    form: b.form,
    depth: b.depth,
    type: b.type,
    text: b.text,
    rule: b.rule ?? null,
    sharedBlockId: b.sharedBlockId ?? null,
    sharedBlockVersion: b.sharedBlockVersion ?? null,
  });

  let next: DraftBlockInput[] = blocks.map(carry);
  let note: string;
  if (!table) {
    /* Last parameter gone: the table goes, and its heading if it was the one written here. */
    const heading = existing > 0 ? blocks[existing - 1] : null;
    const dropHeading = heading?.form === "heading" && heading.text.trim() === "Parameters";
    next = next.filter((b, i) => i !== existing && !(dropHeading && i === existing - 1));
    note = "Parameters table removed";
  } else if (existing !== -1) {
    next[existing] = { ...next[existing], type: "glossary", text: table };
    note = "Parameters table updated";
  } else {
    next.push(
      { form: "heading", depth: 2, type: null, text: "Parameters" },
      { form: "content", depth: null, type: "glossary", text: table },
    );
    note = "Parameters table written";
  }

  await setDraftBlocks(draftId, orgId, next, { reason: "parameters", note, createdBy: userId });
  return { changed: true };
}

// ---------------------------------------------------------------------------------------
// Structure: detect, confirm, make a table, add a row
// ---------------------------------------------------------------------------------------

const RuleRowSchema = z.object({
  when: z
    .array(
      z.object({
        parameter: z.string(),
        op: z.enum(RULE_OPERATORS),
        value: z.string(),
      }),
    )
    .max(4),
  then: z.string(),
  otherwise: z.boolean().optional(),
});

const DetectSchema = z.object({
  parameters: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["enum", "number", "boolean", "free"]),
        values: z.array(z.string()),
        meaning: z.string(),
      }),
    )
    .max(6),
  rows: z.array(RuleRowSchema).max(MAX_RULE_ROWS),
});

const DETECT_SYSTEM = `You read one passage from a skill document written for an AI agent. The passage is a decision rule: it says what to do in some case.

Your job is extraction, not writing. Answer two questions about the passage and nothing else:

1. What does this rule BRANCH ON? Each thing is a parameter: a short noun phrase (\`environment\`, \`change size\`, \`target language\`), a kind, and — when the passage names a closed set — the values it names. Reuse a name from the list of parameters already declared when the passage means the same thing. Kind \`enum\` only when the passage names discrete values; \`number\` for quantities; \`boolean\` for a yes/no; \`free\` when it is named but open.
2. What are the ROWS? Each row is the conditions under which it applies (parameter, operator, value) and the action, in the author's own words — quote or closely paraphrase the passage, never invent an action. A passage that ends with "in any other case …" has a final row with \`otherwise: true\` and no conditions.

Return no parameters and no rows when the passage does not actually branch on anything. That is a correct and common answer.`;

export type DetectReport = {
  blocksRead: number;
  blocksSent: number;
  parametersProposed: number;
  rulesProposed: number;
  costMicros: number;
  /** True when the budget refused part-way and the report describes what was kept. */
  stopped: boolean;
};

/**
 * Read the structure out of the draft's decision rules. One call per block, candidates only.
 *
 * Skips blocks already in step or already carrying a candidate: paying to re-read a sentence
 * whose structure is confirmed is the most expensive no-op on the page. A detached block *is*
 * re-read — its structure describes a sentence that no longer exists.
 *
 * Budget checked before the run and again per call, and the loop **stops and keeps** rather than
 * discarding what it produced — the Distill posture, for the same reason.
 */
export async function detectParameters(input: {
  orgId: string;
  userId: string;
  draftId: string;
}): Promise<DetectReport> {
  const [blocks, declared] = await Promise.all([
    getDraftBlocks(input.draftId, input.orgId),
    listParameters(input.draftId, input.orgId),
  ]);
  const targets = blocks.filter((b) => {
    if (b.form !== "content" || b.type !== "decision-rule") return false;
    const state = ruleState(b);
    return state === "none" || state === "detached";
  });
  const report: DetectReport = {
    blocksRead: blocks.filter((b) => b.type === "decision-rule").length,
    blocksSent: 0,
    parametersProposed: 0,
    rulesProposed: 0,
    costMicros: 0,
    stopped: false,
  };
  if (targets.length === 0) return report;

  const { modelFor } = await import("@/server/settings/models");
  const model = await modelFor("parameters");
  await assertWithinBudget("builder", input.orgId);

  const known = new Map(declared.map((p) => [foldName(p.name), p]));
  const declaredList =
    declared.length === 0
      ? "(none yet)"
      : declared
          .filter((p) => p.decision !== "rejected")
          .map((p) => `- ${p.name} (${p.kind}${p.values.length ? `: ${p.values.join(", ")}` : ""})`)
          .join("\n");

  for (const block of targets) {
    try {
      await assertWithinBudget("builder", input.orgId);
    } catch {
      report.stopped = true;
      break;
    }

    let output: z.infer<typeof DetectSchema> | undefined;
    try {
      const result = await generateText({
        model,
        temperature: 0,
        system: DETECT_SYSTEM,
        prompt: `Parameters already declared on this skill:\n${declaredList}\n\nPassage:\n${block.text}`,
        output: Output.object({ schema: DetectSchema }),
      });
      output = result.output ?? undefined;
      report.costMicros += await recordUsage({
        purpose: "builder",
        orgId: input.orgId,
        model,
        usage: result.usage,
        subjectType: "skill_drafts",
        subjectId: input.draftId,
      });
    } catch {
      /* One refused passage must not cost the run. `mapSettled`'s lesson, sequentially. */
      continue;
    }
    report.blocksSent += 1;
    if (!output) continue;

    /* New parameters land pending. A name already on the draft is reused, never duplicated. */
    const fresh = output.parameters.filter((p) => p.name.trim() && !known.has(foldName(p.name)));
    if (fresh.length > 0) {
      await withExplicitOrgScope(input.orgId, async (tx) => {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(draftParameters)
          .where(eq(draftParameters.draftId, input.draftId));
        const room = Math.max(0, MAX_PARAMETERS - count);
        for (const p of fresh.slice(0, room)) {
          const kind: ParameterKind = p.kind;
          const values = cleanValues(kind, p.values);
          /* An enum the model could not give values for is stored as free text, not refused: it is a candidate. */
          const rows = await tx
            .insert(draftParameters)
            .values({
              orgId: input.orgId,
              draftId: input.draftId,
              name: p.name.trim().slice(0, MAX_PARAMETER_NAME),
              kind: kind === "enum" && values.length === 0 ? "free" : kind,
              values,
              meaning: p.meaning.trim().slice(0, 300) || null,
              source: "detected",
              decision: "pending",
              createdBy: input.userId,
            })
            .onConflictDoNothing()
            .returning({ id: draftParameters.id });
          if (rows.length > 0) {
            report.parametersProposed += 1;
            known.set(foldName(p.name), { ...p, id: rows[0].id, source: "detected", decision: "pending" });
          }
        }
      });
    }

    const rows: RuleRow[] = output.rows
      .filter((row) => row.otherwise || row.when.length > 0)
      .map((row) => ({ when: row.when, then: row.then, ...(row.otherwise ? { otherwise: true } : {}) }));
    if (rows.length === 0) continue;

    /*
     * A candidate on the block, and only the `rule` column. The text is untouched, so the body —
     * a render of the text — is untouched, and there is nothing for the one writer to write.
     */
    const candidate: BlockRule = buildRule(rows, false);
    await withExplicitOrgScope(input.orgId, async (tx) => {
      await tx
        .update(draftBlocks)
        .set({ rule: candidate, updatedAt: new Date() })
        .where(and(eq(draftBlocks.id, block.id), eq(draftBlocks.draftId, input.draftId)));
    });
    report.rulesProposed += 1;
  }

  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "parameters.detected",
      subjectType: "skill_drafts",
      subjectId: input.draftId,
      payload: { ...report },
    });
  });

  return report;
}

/**
 * Confirm or reject a candidate structure. Structure only — the sentence is the author's and does
 * not move, so this is the one write here that does not go through `setDraftBlocks`: there is no
 * text change to render, and the revision diff would be empty.
 */
export async function decideRule(input: {
  orgId: string;
  userId: string;
  draftId: string;
  blockId: string;
  decision: "confirm" | "reject";
}): Promise<ParameterResult<{ state: RuleState }>> {
  const blocks = await getDraftBlocks(input.draftId, input.orgId);
  const block = blocks.find((b) => b.id === input.blockId);
  if (!block) return { ok: false, refusal: "not-found" };
  if (!block.rule) return { ok: false, refusal: "no-structure" };

  const rule = input.decision === "confirm" ? confirmRuleFor(block.text, block.rule) : null;
  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx
      .update(draftBlocks)
      .set({ rule, updatedAt: new Date() })
      .where(and(eq(draftBlocks.id, input.blockId), eq(draftBlocks.draftId, input.draftId)));
  });
  return { ok: true, data: { state: ruleState({ text: block.text, rule }) } };
}

/**
 * "Make this a table." Several rules that branch on the same parameters become one decision table
 * in the first one's place; the others are merged away (C1b's merge), and the history says so.
 *
 * Requires confirmed structure on every block. Merging prose the model has only guessed at would
 * put words in a table the author never checked.
 */
export async function makeTable(input: {
  orgId: string;
  userId: string;
  draftId: string;
  blockIds: string[];
}): Promise<ParameterResult<{ blockId: string; rows: number }>> {
  const ids = [...new Set(input.blockIds)];
  if (ids.length < 2) return { ok: false, refusal: "too-few-blocks" };
  const blocks = await getDraftBlocks(input.draftId, input.orgId);
  const chosen = blocks.filter((b) => ids.includes(b.id));
  if (chosen.length !== ids.length) return { ok: false, refusal: "not-found" };
  if (chosen.some((b) => b.type !== "decision-rule")) return { ok: false, refusal: "not-decision-rules" };
  if (chosen.some((b) => !b.rule || ruleState(b) !== "in-step")) return { ok: false, refusal: "no-structure" };

  const rows = chosen.flatMap((b) => b.rule?.rows ?? []).slice(0, MAX_RULE_ROWS);
  if (ruleParameters(rows).length === 0) return { ok: false, refusal: "no-structure" };
  const text = renderRule(rows);
  const first = chosen[0].id;
  const rest = new Set(ids.filter((id) => id !== first));

  const next = blocks
    .filter((b) => !rest.has(b.id))
    .map((b) =>
      b.id === first
        ? { id: b.id, form: b.form, depth: b.depth, type: "decision-rule" as const, text, rule: buildRule(rows, true) }
        : {
            id: b.id,
            form: b.form,
            depth: b.depth,
            type: b.type,
            text: b.text,
            rule: b.rule ?? null,
            sharedBlockId: b.sharedBlockId ?? null,
            sharedBlockVersion: b.sharedBlockVersion ?? null,
          },
    );

  await setDraftBlocks(input.draftId, input.orgId, next, {
    reason: "parameters",
    note: `${chosen.length} rules → one table`,
    createdBy: input.userId,
  });
  return { ok: true, data: { blockId: first, rows: rows.length } };
}

/**
 * "Add a rule here." An empty row for a case coverage found uncovered — the condition filled in,
 * the action left as `…` for the author. Never anybody's action: the same restraint as C1b's
 * "add one here" and the block library's missing copy button.
 *
 * Appended to an in-step table when one is named; otherwise a new decision-rule block at the end.
 */
export async function addRuleRow(input: {
  orgId: string;
  userId: string;
  draftId: string;
  parameter: string;
  value: string;
  blockId?: string | null;
}): Promise<ParameterResult<{ blockId: string }>> {
  const parameter = input.parameter.trim();
  const value = input.value.trim();
  if (!parameter || !value) return { ok: false, refusal: "empty" };

  const blocks = await getDraftBlocks(input.draftId, input.orgId);
  const row: RuleRow = { when: [{ parameter, op: "is", value }], then: "" };
  const carry: DraftBlockInput[] = blocks.map((b) => ({
    id: b.id,
    form: b.form,
    depth: b.depth,
    type: b.type,
    text: b.text,
    rule: b.rule ?? null,
    sharedBlockId: b.sharedBlockId ?? null,
    sharedBlockVersion: b.sharedBlockVersion ?? null,
  }));

  const target = input.blockId ? blocks.find((b) => b.id === input.blockId) : undefined;
  const appendTo =
    target && target.rule && ruleState(target) === "in-step" && target.rule.rows.length < MAX_RULE_ROWS
      ? target
      : null;
  if (appendTo?.rule) {
    const rows = [...appendTo.rule.rows, row];
    const i = carry.findIndex((b) => b.id === appendTo.id);
    carry[i] = { ...carry[i], type: "decision-rule", text: renderRule(rows), rule: buildRule(rows, true) };
  } else {
    carry.push({
      form: "content",
      depth: null,
      type: "decision-rule",
      text: renderRule([row]),
      rule: buildRule([row], true),
    });
  }

  const result = await setDraftBlocks(input.draftId, input.orgId, carry, {
    reason: "parameters",
    note: `rule added for ${parameter} = ${value}`,
    createdBy: input.userId,
  });
  return {
    ok: true,
    data: { blockId: appendTo?.id ?? result.blocks[result.blocks.length - 1]?.id ?? "" },
  };
}

// ---------------------------------------------------------------------------------------
// Findings: coverage (free) and consistency (metered, on demand)
// ---------------------------------------------------------------------------------------

export type RuleSummary = {
  blockId: string;
  order: number;
  state: RuleState;
  excerpt: string;
  rows: number;
  parameters: string[];
};

/** Every decision-rule block on the draft with where it stands. Derived on read. */
export function summariseRules(blocks: Awaited<ReturnType<typeof getDraftBlocks>>): RuleSummary[] {
  return blocks
    .filter((b) => b.form === "content" && b.type === "decision-rule")
    .map((b) => ({
      blockId: b.id,
      order: b.order,
      state: ruleState(b),
      excerpt: b.text.replace(/\s+/g, " ").slice(0, 140),
      rows: b.rule?.rows.length ?? 0,
      parameters: b.rule ? ruleParameters(b.rule.rows) : [],
    }));
}

/**
 * Coverage of the declared case space by the confirmed, in-step rules. Arithmetic, free, renders
 * with the page. A candidate is a suggestion and a detached structure describes a sentence that
 * no longer exists, so neither counts.
 */
export async function coverageFor(
  draftId: string,
  orgId: string,
): Promise<{ coverage: CoverageReport; rules: RuleSummary[]; parameters: DraftParameter[] }> {
  const [parameters, blocks] = await Promise.all([
    listParameters(draftId, orgId),
    getDraftBlocks(draftId, orgId),
  ]);
  const inStep = blocks
    .filter((b) => b.rule && ruleState(b) === "in-step")
    .map((b) => ({ rows: b.rule?.rows ?? [] }));
  return {
    coverage: coverage(parameters, inStep),
    rules: summariseRules(blocks),
    parameters,
  };
}

const ConflictSchema = z.object({
  conflict: z.boolean(),
  why: z.string(),
});

/*
 * RK.3's test, pointed inside one document: is there any one course of action that satisfies both
 * rules? A stricter rule beside a looser one is not a conflict — doing the stricter thing satisfies
 * both. The worked example is there because a rule stated abstractly is a rule a model can agree
 * with and then ignore, which is exactly what `verify:relations --live` found.
 */
const CONFLICT_SYSTEM = `Two decision rules from ONE skill document are given. Their conditions can both be true at the same time. Decide whether an agent following both would be told to do incompatible things.

The single test: is there any one course of action that satisfies BOTH rules? If yes, there is NO conflict.

Not a conflict: one rule is stricter than the other ("at least one reviewer" and "at least two reviewers" — two reviewers satisfies both); the rules address different aspects of the same case; one adds a step the other does not mention.

A conflict: the two actions cannot both be done ("merge immediately" and "never merge without a second approval"; "use JSON" and "use YAML" for the same output).

Answer with conflict true or false and one sentence saying why, quoting the two actions.`;

export type ConsistencyFinding = {
  a: { blockId: string; row: number; text: string };
  b: { blockId: string; row: number; text: string };
  why: string;
};

export type ConsistencyReport = {
  pairsConsidered: number;
  pairsAsked: number;
  conflicts: ConsistencyFinding[];
  costMicros: number;
  stopped: boolean;
};

/**
 * Pairs of in-step rows that can both fire and share a parameter, judged for contradiction. On
 * demand, one call per pair, bounded. Never stored: it is a claim about the document as it is right
 * now, and the next edit changes it.
 */
export async function consistencyCheck(input: {
  orgId: string;
  userId: string;
  draftId: string;
}): Promise<ConsistencyReport> {
  const blocks = await getDraftBlocks(input.draftId, input.orgId);
  const rows: Array<{ blockId: string; row: number; rule: RuleRow }> = [];
  for (const b of blocks) {
    if (!b.rule || ruleState(b) !== "in-step") continue;
    b.rule.rows.forEach((rule, row) => rows.push({ blockId: b.id, row, rule }));
  }

  const pairs: Array<[(typeof rows)[number], (typeof rows)[number]]> = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i].rule;
      const b = rows[j].rule;
      const shared = ruleParameters([a]).some((p) =>
        ruleParameters([b]).some((q) => foldName(p) === foldName(q)),
      );
      /* Rules on different parameters are refused a verdict: nothing here knows they are about the same decision. */
      if (shared && mayCoHold(a, b) && a.then.trim() && b.then.trim()) pairs.push([rows[i], rows[j]]);
    }
  }

  const report: ConsistencyReport = {
    pairsConsidered: pairs.length,
    pairsAsked: 0,
    conflicts: [],
    costMicros: 0,
    stopped: false,
  };
  if (pairs.length === 0) return report;

  const { modelFor } = await import("@/server/settings/models");
  const model = await modelFor("parameters");
  await assertWithinBudget("builder", input.orgId);

  for (const [a, b] of pairs.slice(0, MAX_CONSISTENCY_PAIRS)) {
    try {
      await assertWithinBudget("builder", input.orgId);
    } catch {
      report.stopped = true;
      break;
    }
    try {
      const result = await generateText({
        model,
        temperature: 0,
        system: CONFLICT_SYSTEM,
        prompt: `Rule A: ${renderRule([a.rule])}\n\nRule B: ${renderRule([b.rule])}`,
        output: Output.object({ schema: ConflictSchema }),
      });
      report.costMicros += await recordUsage({
        purpose: "builder",
        orgId: input.orgId,
        model,
        usage: result.usage,
        subjectType: "skill_drafts",
        subjectId: input.draftId,
      });
      report.pairsAsked += 1;
      if (result.output?.conflict) {
        report.conflicts.push({
          a: { blockId: a.blockId, row: a.row, text: a.rule.then },
          b: { blockId: b.blockId, row: b.row, text: b.rule.then },
          why: result.output.why.slice(0, 400),
        });
      }
    } catch {
      continue;
    }
  }

  await withExplicitOrgScope(input.orgId, async (tx) => {
    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "parameters.consistency",
      subjectType: "skill_drafts",
      subjectId: input.draftId,
      payload: {
        pairsConsidered: report.pairsConsidered,
        pairsAsked: report.pairsAsked,
        conflicts: report.conflicts.length,
        costMicros: report.costMicros,
      },
    });
  });

  return report;
}
