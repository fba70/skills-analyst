/**
 * A skill's own parameters, and the decision rules that branch on them (Doc 7 RD.1–RD.3,
 * plan step P4).
 *
 * ## Why this exists
 *
 * `decision-rule` is the strongest discriminating block type in the corpus — a place in 10 of 13
 * categories at a median lift of +22 — and the designer knew nothing about what a rule branches
 * on. It could say *good review skills carry decision rules and yours has none* and could not say
 * *your rule covers `prod` and `staging` and says nothing about `dev`*, which is the sentence an
 * author can act on. Doc 6 §2 named the quality signal this block carries as **coverage of the
 * case space**, and nothing measured it.
 *
 * So a skill may declare **parameters** — the named things its behaviour depends on — and a
 * decision-rule block may carry a **structure** behind its prose: conditions over those parameters
 * and an action in the author's words. Coverage and consistency are then arithmetic over rows.
 *
 * ## The document stays the artefact
 *
 * Nothing here is a runtime dependency. A parameter renders to an ordinary markdown table; a
 * structured rule renders to a sentence or a decision table. An agent reads a document, and the
 * platform does not evaluate "if A is X" — it makes the rule complete, consistent and legible.
 * There is no new frontmatter key, because the Agent Skills standard has none and inventing one
 * would make the export dialect-specific.
 *
 * ## Structure → prose is deterministic; prose → structure is a candidate
 *
 * `renderRule` is a pure function of the rows, byte-stable across calls, so the same structure
 * always produces the same text and a stored hash of that text says whether the author has since
 * edited it. Reading structure *out of* prose is model-assisted and produces candidates the author
 * confirms — nothing rewrites their sentence, and an edited render **detaches** rather than being
 * silently re-rendered, exactly as a shared block goes `behind` rather than changing under its
 * author.
 *
 * ## A leaf, for the reasons the others are
 *
 * The panel is a client component, the writer is `server-only`, and the verify script wants to
 * exercise the maths with no database. One copy, reachable from all three. Same split as
 * `draft-blocks.ts`, `shared-blocks.ts` and `campaigns.ts`.
 */

export const PARAMETER_KINDS = ["enum", "number", "boolean", "free"] as const;

export type ParameterKind = (typeof PARAMETER_KINDS)[number];

export function isParameterKind(value: unknown): value is ParameterKind {
  return typeof value === "string" && (PARAMETER_KINDS as readonly string[]).includes(value);
}

export const PARAMETER_KIND_META: Record<ParameterKind, { label: string; blurb: string }> = {
  enum: {
    label: "One of a list",
    blurb: "A closed set of values — environment, severity, language. The only kind coverage can be measured over.",
  },
  number: {
    label: "A number",
    blurb: "A quantity a rule compares against — file count, change size, latency. Coverage is not measurable; ranges are the author's call.",
  },
  boolean: {
    label: "Yes or no",
    blurb: "A flag. Measured as a two-value list.",
  },
  free: {
    label: "Free text",
    blurb: "Something a rule names without a closed set. Declared for the glossary, never measured.",
  },
};

/** Where a parameter came from. Declared by hand, detected from the draft's rules, or suggested. */
export const PARAMETER_SOURCES = ["declared", "detected", "suggested"] as const;

export type ParameterSource = (typeof PARAMETER_SOURCES)[number];

export function isParameterSource(value: unknown): value is ParameterSource {
  return typeof value === "string" && (PARAMETER_SOURCES as readonly string[]).includes(value);
}

/**
 * A detected or suggested parameter is a **candidate** until the author decides. A declared one is
 * accepted on arrival — the author typed it. A rejected candidate is kept, for the reason a rejected
 * interview candidate is: a source whose suggestions are always rejected is only prunable if the
 * rejections exist.
 */
export const PARAMETER_DECISIONS = ["pending", "accepted", "rejected"] as const;

export type ParameterDecision = (typeof PARAMETER_DECISIONS)[number];

export function isParameterDecision(value: unknown): value is ParameterDecision {
  return typeof value === "string" && (PARAMETER_DECISIONS as readonly string[]).includes(value);
}

export type Parameter = {
  id?: string;
  name: string;
  kind: ParameterKind;
  /** The closed set, for `enum`. Empty for every other kind. */
  values: string[];
  unit?: string | null;
  meaning?: string | null;
  source?: ParameterSource;
  decision?: ParameterDecision;
};

export const MAX_PARAMETERS = 24;
export const MAX_PARAMETER_VALUES = 24;
export const MAX_PARAMETER_NAME = 60;
export const MAX_RULE_CONDITIONS = 4;
/** Rows one block may carry. More than that is a section wearing a table's clothes. */
export const MAX_RULE_ROWS = 40;

/**
 * How a condition compares a parameter against a value.
 *
 * Words, not symbols, because the render is prose an agent reads and `>=` inside a sentence is a
 * typo to most readers. The two `is` forms are the whole of what an enum needs; the four ordered
 * ones exist for numbers; `in` is shorthand for several `is` rows that share an action.
 */
export const RULE_OPERATORS = ["is", "is-not", "in", "above", "at-least", "below", "at-most"] as const;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

export function isRuleOperator(value: unknown): value is RuleOperator {
  return typeof value === "string" && (RULE_OPERATORS as readonly string[]).includes(value);
}

export const RULE_OPERATOR_LABEL: Record<RuleOperator, string> = {
  is: "is",
  "is-not": "is not",
  in: "is one of",
  above: "is above",
  "at-least": "is at least",
  below: "is below",
  "at-most": "is at most",
};

export type RuleCondition = {
  /** The parameter's name. By name rather than id so a rule survives the parameter being deleted — it becomes prose about a word, not a dangling pointer. */
  parameter: string;
  op: RuleOperator;
  /** One value, or for `in` a comma-separated list. */
  value: string;
};

/**
 * One row of a decision: when these conditions hold, do this.
 *
 * `otherwise` is a row with no conditions. It is a **rule, not a hole**: a skill is allowed to say
 * *any other case — use judgment and say so*, and coverage counts it as covering every value the
 * block's other rows left out.
 */
export type RuleRow = {
  when: RuleCondition[];
  then: string;
  otherwise?: boolean;
};

/**
 * The structure behind a `decision-rule` block. Sits on the block it describes
 * (`draft_blocks.rule`), never in a second table that could disagree with it.
 *
 * `renderHash` is the hash of the text this structure **describes** — the render, when the text
 * is the render (a table made here, a row added here), or the author's own sentence at the moment
 * they confirmed a candidate read out of it. If the block's text no longer hashes to it, the
 * author edited the passage and the structure is **out of date** — shown, never silently
 * repaired. `confirmed` is false while the structure is a model's candidate.
 */
export type BlockRule = {
  rows: RuleRow[];
  renderHash: string;
  confirmed: boolean;
};

/** Confirm a candidate against the text it was read from. The structure now describes *that* sentence. */
export function confirmRuleFor(text: string, rule: BlockRule): BlockRule {
  return { rows: rule.rows.map(normaliseRow), renderHash: textHash(text), confirmed: true };
}

/** Pairs the consistency check may ask about: both can fire, and they share a parameter. */
export const MAX_CONSISTENCY_PAIRS = 20;

export function isBlockRule(value: unknown): value is BlockRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  if (!Array.isArray(rule.rows) || typeof rule.renderHash !== "string") return false;
  if (typeof rule.confirmed !== "boolean") return false;
  return rule.rows.every((row) => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    if (typeof r.then !== "string" || !Array.isArray(r.when)) return false;
    return r.when.every(
      (c) =>
        c &&
        typeof c === "object" &&
        typeof (c as RuleCondition).parameter === "string" &&
        isRuleOperator((c as RuleCondition).op) &&
        typeof (c as RuleCondition).value === "string",
    );
  });
}

/** Two names differing only in case or surrounding space are one parameter. */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * FNV-1a over UTF-16 code units, hex. Not cryptographic and does not need to be: it answers "is
 * this the text I rendered", and a collision costs a detached mark that is not shown. Inline
 * because a leaf module imports nothing — `node:crypto` is not available to the client component
 * that shows the mark.
 */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  const s = text.trim();
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Where a block stands in relation to its structure. **Derived, never stored** — the same call the
 * transclusion state makes from two version numbers.
 */
export const RULE_STATES = ["none", "candidate", "in-step", "detached"] as const;

export type RuleState = (typeof RULE_STATES)[number];

export const RULE_STATE_META: Record<RuleState, { label: string; blurb: string }> = {
  none: { label: "Prose", blurb: "No structure behind this rule. It is a sentence, and that is allowed." },
  candidate: {
    label: "Suggested structure",
    blurb: "A model read a structure out of this sentence. Nothing has changed until you confirm it.",
  },
  "in-step": {
    label: "In step",
    blurb: "The text is exactly what the structure renders to. Coverage counts these rows.",
  },
  detached: {
    label: "Structure out of date",
    blurb:
      "You edited the rendered text, so the structure describes an older sentence. Nothing was re-rendered for you — re-detect when you are ready, or leave it as prose.",
  },
};

export function ruleState(block: { text: string; rule?: BlockRule | null }): RuleState {
  if (!block.rule) return "none";
  if (!block.rule.confirmed) return "candidate";
  return textHash(block.text) === block.rule.renderHash ? "in-step" : "detached";
}

// ---------------------------------------------------------------------------------------
// Rendering — deterministic, byte-stable, no model
// ---------------------------------------------------------------------------------------

function tick(value: string): string {
  const v = value.trim();
  return v ? `\`${v}\`` : "…";
}

function renderCondition(c: RuleCondition): string {
  if (c.op === "in") {
    const values = c.value.split(",").map((v) => v.trim()).filter(Boolean);
    return `**${c.parameter.trim()}** is one of ${values.map(tick).join(", ")}`;
  }
  return `**${c.parameter.trim()}** ${RULE_OPERATOR_LABEL[c.op]} ${tick(c.value)}`;
}

function cell(c: RuleCondition): string {
  if (c.op === "is") return tick(c.value);
  if (c.op === "in")
    return c.value.split(",").map((v) => v.trim()).filter(Boolean).map(tick).join(", ");
  return `${RULE_OPERATOR_LABEL[c.op].replace(/^is /, "")} ${tick(c.value)}`;
}

/** Parameters named across the rows, in order of first appearance. The table's columns. */
export function ruleParameters(rows: ReadonlyArray<RuleRow>): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const c of row.when) {
      const key = foldName(c.parameter);
      if (key && !seen.has(key)) seen.set(key, c.parameter.trim());
    }
  }
  return [...seen.values()];
}

/**
 * Structure → markdown.
 *
 * One row is a sentence; two or more are a table whose columns are the parameters the rows name.
 * An empty action renders as `…` so an "add a rule here" row is visibly unfinished rather than
 * pretending to say something. Pure, and asserted byte-stable by `verify:parameters`.
 */
export function renderRule(rows: ReadonlyArray<RuleRow>): string {
  const real = rows.filter((row) => row.otherwise || row.when.length > 0);
  if (real.length === 0) return "";

  if (real.length === 1) {
    const [row] = real;
    if (row.otherwise) return `Otherwise, ${row.then.trim() || "…"}`;
    return `If ${row.when.map(renderCondition).join(" and ")}, then ${row.then.trim() || "…"}`;
  }

  const columns = ruleParameters(real);
  const header = `| ${columns.join(" | ")} | Then |`;
  const divider = `|${columns.map(() => "---|").join("")}---|`;
  const lines = real.map((row) => {
    if (row.otherwise) {
      const cells = columns.map((_, i) => (i === 0 ? "*otherwise*" : "—"));
      return `| ${cells.join(" | ")} | ${row.then.trim() || "…"} |`;
    }
    const cells = columns.map((column) => {
      const c = row.when.find((w) => foldName(w.parameter) === foldName(column));
      return c ? cell(c) : "—";
    });
    return `| ${cells.join(" | ")} | ${row.then.trim() || "…"} |`;
  });
  return [header, divider, ...lines].join("\n");
}

/** A `BlockRule` whose hash matches its own render. The only correct way to construct one. */
export function buildRule(rows: ReadonlyArray<RuleRow>, confirmed: boolean): BlockRule {
  return { rows: rows.map(normaliseRow), renderHash: textHash(renderRule(rows)), confirmed };
}

export function normaliseRow(row: RuleRow): RuleRow {
  return {
    when: row.otherwise
      ? []
      : row.when.slice(0, MAX_RULE_CONDITIONS).map((c) => ({
          parameter: c.parameter.trim().slice(0, MAX_PARAMETER_NAME),
          op: c.op,
          value: c.value.trim(),
        })),
    then: row.then.trim(),
    ...(row.otherwise ? { otherwise: true as const } : {}),
  };
}

/** The first line of the Parameters table. How the block carrying it is recognised in a draft. */
export const PARAMETERS_TABLE_HEADER = "| Parameter | Kind | Values | Meaning |";

/**
 * The declared parameters as a glossary table. Ordinary markdown under a glossary-role heading;
 * an agent reads it as the inputs that matter. Written into the body through the one block
 * writer like every other change, never by a second render path.
 */
export function renderParametersTable(parameters: ReadonlyArray<Parameter>): string {
  const rows = parameters
    .filter((p) => (p.decision ?? "accepted") === "accepted")
    .map((p) => {
      const values =
        p.kind === "enum"
          ? p.values.map(tick).join(", ")
          : p.kind === "boolean"
            ? "`true`, `false`"
            : p.unit
              ? `${PARAMETER_KIND_META[p.kind].label.toLowerCase()} (${p.unit})`
              : PARAMETER_KIND_META[p.kind].label.toLowerCase();
      return `| ${p.name.trim()} | ${p.kind} | ${values} | ${(p.meaning ?? "").trim() || "—"} |`;
    });
  if (rows.length === 0) return "";
  return [PARAMETERS_TABLE_HEADER, "|---|---|---|---|", ...rows].join("\n");
}

export function isParametersTable(text: string): boolean {
  return text.trimStart().startsWith(PARAMETERS_TABLE_HEADER);
}

// ---------------------------------------------------------------------------------------
// Coverage — arithmetic over declared values and structured rows. Free.
// ---------------------------------------------------------------------------------------

export type ParameterCoverage = {
  name: string;
  kind: ParameterKind;
  /**
   * False for a number, free text, or an enum with no declared values. Then `share` is null and
   * `missing` is empty — **not measurable is not 0%**. The two are the same number and opposite
   * meanings, and this codebase has paid for confusing them more than once.
   */
  measurable: boolean;
  declared: number;
  covered: number;
  /** Declared values no row names, when there is no `otherwise` to catch them. */
  missing: string[];
  share: number | null;
  /** Rows that reference this parameter. Zero is *unused*, which is allowed. */
  rows: number;
};

export type JointCoverage = {
  parameters: [string, string];
  combinations: number;
  covered: number;
  share: number;
};

export type CoverageReport = {
  parameters: ParameterCoverage[];
  /** Only for pairs some row genuinely combines. A joint number over parameters no rule combines would be invented. */
  joint: JointCoverage[];
  structuredRows: number;
};

function effectiveValues(p: Parameter): string[] | null {
  if (p.kind === "boolean") return ["true", "false"];
  if (p.kind === "enum") return p.values.length > 0 ? p.values : null;
  return null;
}

function valuesNamed(c: RuleCondition, all: string[]): string[] {
  const fold = (v: string) => v.trim().toLowerCase();
  if (c.op === "is") return all.filter((v) => fold(v) === fold(c.value));
  if (c.op === "in") {
    const wanted = new Set(c.value.split(",").map(fold).filter(Boolean));
    return all.filter((v) => wanted.has(fold(v)));
  }
  if (c.op === "is-not") return all.filter((v) => fold(v) !== fold(c.value));
  return [];
}

/**
 * How much of the declared case space the structured rules reach.
 *
 * Only **in-step, confirmed** rows count — a candidate is a suggestion and a detached structure
 * describes a sentence that no longer exists. Callers filter before handing rows in; this function
 * does the arithmetic and nothing else.
 */
export function coverage(
  parameters: ReadonlyArray<Parameter>,
  blocks: ReadonlyArray<{ rows: RuleRow[] }>,
): CoverageReport {
  const accepted = parameters.filter((p) => (p.decision ?? "accepted") === "accepted");
  const rows = blocks.flatMap((b) => b.rows);

  const perParameter: ParameterCoverage[] = accepted.map((p) => {
    const key = foldName(p.name);
    const naming = rows.filter((row) => row.when.some((c) => foldName(c.parameter) === key));
    const all = effectiveValues(p);
    if (!all) {
      return {
        name: p.name,
        kind: p.kind,
        measurable: false,
        declared: 0,
        covered: 0,
        missing: [],
        share: null,
        rows: naming.length,
      };
    }
    /*
     * An `otherwise` row covers every value the *same block's* other rows left out — that is the
     * scope in which the author wrote it. A block that names this parameter and carries an
     * otherwise row therefore closes the parameter's case space.
     */
    const closed = blocks.some(
      (b) =>
        b.rows.some((row) => row.otherwise) &&
        b.rows.some((row) => row.when.some((c) => foldName(c.parameter) === key)),
    );
    const covered = new Set<string>();
    if (closed) all.forEach((v) => covered.add(v));
    for (const row of naming) {
      for (const c of row.when) {
        if (foldName(c.parameter) !== key) continue;
        valuesNamed(c, all).forEach((v) => covered.add(v));
      }
    }
    const missing = all.filter((v) => !covered.has(v));
    return {
      name: p.name,
      kind: p.kind,
      measurable: true,
      declared: all.length,
      covered: covered.size,
      missing,
      share: Math.round((covered.size / all.length) * 100),
      rows: naming.length,
    };
  });

  /*
   * Joint coverage over a pair only when some row pins both — otherwise the product is a claim
   * about a decision the author never wrote as a joint one.
   */
  const joint: JointCoverage[] = [];
  const measurable = accepted.filter((p) => effectiveValues(p) !== null);
  for (let i = 0; i < measurable.length; i += 1) {
    for (let j = i + 1; j < measurable.length; j += 1) {
      const a = measurable[i];
      const b = measurable[j];
      const ka = foldName(a.name);
      const kb = foldName(b.name);
      const combining = rows.filter(
        (row) =>
          row.when.some((c) => foldName(c.parameter) === ka) &&
          row.when.some((c) => foldName(c.parameter) === kb),
      );
      if (combining.length === 0) continue;
      const va = effectiveValues(a) ?? [];
      const vb = effectiveValues(b) ?? [];
      const hit = new Set<string>();
      for (const row of combining) {
        const ca = row.when.filter((c) => foldName(c.parameter) === ka).flatMap((c) => valuesNamed(c, va));
        const cb = row.when.filter((c) => foldName(c.parameter) === kb).flatMap((c) => valuesNamed(c, vb));
        for (const x of ca) for (const y of cb) hit.add(`${x} ${y}`);
      }
      const combinations = va.length * vb.length;
      joint.push({
        parameters: [a.name, b.name],
        combinations,
        covered: hit.size,
        share: Math.round((hit.size / combinations) * 100),
      });
    }
  }

  return { parameters: perParameter, joint, structuredRows: rows.length };
}

/**
 * Can two rows hold at the same time? Pure, and the pre-filter for the consistency check: a model
 * is only asked about pairs that can both fire. Two rows on disjoint parameters can always both
 * hold; two `is` conditions on one parameter with different values never can. Ranges are compared
 * numerically where both sides parse, and treated as compatible where they do not — the safe
 * direction is to ask rather than to assume no conflict.
 */
export function mayCoHold(a: RuleRow, b: RuleRow): boolean {
  if (a.otherwise || b.otherwise) return false;
  for (const ca of a.when) {
    for (const cb of b.when) {
      if (foldName(ca.parameter) !== foldName(cb.parameter)) continue;
      if (!compatible(ca, cb)) return false;
    }
  }
  return true;
}

function compatible(a: RuleCondition, b: RuleCondition): boolean {
  const fold = (v: string) => v.trim().toLowerCase();
  const setOf = (c: RuleCondition) =>
    new Set(c.op === "in" ? c.value.split(",").map(fold).filter(Boolean) : [fold(c.value)]);
  const isLike = (c: RuleCondition) => c.op === "is" || c.op === "in";
  if (isLike(a) && isLike(b)) {
    const sb = setOf(b);
    return [...setOf(a)].some((v) => sb.has(v));
  }
  if (isLike(a) && b.op === "is-not") return [...setOf(a)].some((v) => v !== fold(b.value));
  if (isLike(b) && a.op === "is-not") return [...setOf(b)].some((v) => v !== fold(a.value));
  const na = Number(a.value);
  const nb = Number(b.value);
  if (Number.isNaN(na) || Number.isNaN(nb)) return true;
  const lower = (c: RuleCondition, n: number) =>
    c.op === "above" ? { min: n, open: true } : c.op === "at-least" ? { min: n, open: false } : null;
  const upper = (c: RuleCondition, n: number) =>
    c.op === "below" ? { max: n, open: true } : c.op === "at-most" ? { max: n, open: false } : null;
  const la = lower(a, na) ?? lower(b, nb);
  const ua = upper(a, na) ?? upper(b, nb);
  if (la && ua) return la.open || ua.open ? la.min < ua.max : la.min <= ua.max;
  return true;
}

// ---------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------

export const PARAMETER_REFUSALS = [
  "not-found",
  "empty",
  "duplicate-name",
  "enum-without-values",
  "too-many-parameters",
  "too-many-values",
  "no-structure",
  "too-few-blocks",
  "not-decision-rules",
] as const;

export type ParameterRefusal = (typeof PARAMETER_REFUSALS)[number];

export const PARAMETER_REFUSAL_MESSAGE: Record<ParameterRefusal, string> = {
  "not-found": "No such parameter on this draft.",
  empty: "Give the parameter a name.",
  "duplicate-name": "A parameter with that name already exists on this draft. Edit it instead of adding a second.",
  "enum-without-values":
    "A parameter that is one of a list needs the list. Without it there is nothing to measure coverage against — pick another kind if the values are open.",
  "too-many-parameters": `A skill declares at most ${MAX_PARAMETERS} parameters. More than that is two skills.`,
  "too-many-values": `A list holds at most ${MAX_PARAMETER_VALUES} values.`,
  "no-structure":
    "That block has no confirmed structure behind it yet. Detect its parameters first, then confirm what the model read.",
  "too-few-blocks": "Making a table needs at least two rules that branch on the same parameter.",
  "not-decision-rules": "Only decision-rule blocks can become a table.",
};
