import { destructiveAmong, toolById, toolLabel, type ToolCapability } from "./tools";

/**
 * Contract alignment (Doc 7 RD.8, plan step P2) — three sources, one agreement.
 *
 * A skill says what it runs in three different places and nothing has ever compared them:
 *
 * - **prose** — the steps and tool contracts, which is what an agent reads and acts on;
 * - **frontmatter** — Claude Code's `allowed-tools`, which is what the harness *enforces*;
 * - **the bundle** — what R2.4 measures the shipped code actually reaching.
 *
 * Disagreement between them is not a safety question and must never block a publish. It is a
 * *completeness* question, and the kind an author fixes in a minute once somebody points at
 * it: a step that runs `kubectl` against an `allowed-tools` that does not list it is a call
 * the harness refuses at the moment it matters.
 *
 * ## Why this is a leaf module
 *
 * The panel is a client component and the analysis is `server-only`, so the vocabulary and the
 * comparison live here — the split `capabilities.ts` and `block-types.ts` already make. It
 * imports only `tools.ts`, itself a leaf, which is what lets `verify:tool-alignment` exercise
 * every rule with no database and no bundle.
 *
 * ## Nothing here is a gate
 *
 * R4.5's analyzers decide whether a draft may publish, and they are not consulted here.
 * `verify:tool-alignment` asserts a draft with the loudest finding this module can produce
 * still publishes, because a deployment skill that runs `kubectl delete` is doing its job and
 * a designer that refused it would be converting advice into a prohibition nobody asked for.
 */

export const ALIGNMENT_KINDS = [
  /** A step runs it; `allowed-tools` does not grant it. The harness will refuse the call. */
  "undeclared",
  /** `allowed-tools` grants it; nothing in the document uses it. */
  "unused",
  /** Bundled code reaches a capability no tool contract mentions. R2.4's own warning. */
  "undocumented-capability",
  /** A destructive tool is named and the draft carries no guardrail at all. */
  "unguarded-destructive",
] as const;

export type AlignmentKind = (typeof ALIGNMENT_KINDS)[number];

export const ALIGNMENT_META: Record<
  AlignmentKind,
  { label: string; blurb: string; severity: "act" | "consider" }
> = {
  undeclared: {
    label: "Not granted",
    blurb:
      "A step runs this and `allowed-tools` does not list it, so Claude Code refuses the call at the moment it is needed.",
    severity: "act",
  },
  unused: {
    label: "Granted, unused",
    blurb:
      "`allowed-tools` grants this and no step uses it. A broad grant may be deliberate, so nothing is changed for you.",
    severity: "consider",
  },
  "undocumented-capability": {
    label: "Undocumented reach",
    blurb:
      "A bundled script reaches this and no tool contract says so. A reader deciding whether to install cannot see it.",
    severity: "act",
  },
  "unguarded-destructive": {
    label: "No guardrail",
    blurb:
      "This can destroy data or change live state, and the document states no constraint on using it.",
    severity: "consider",
  },
};

/** What the designer offers to do about a finding. `none` is a real and common answer. */
export const ALIGNMENT_FIXES = [
  "generate-allowed-tools",
  "add-tool-contract",
  "add-guardrail",
  "none",
] as const;

export type AlignmentFix = (typeof ALIGNMENT_FIXES)[number];

export type AlignmentFinding = {
  kind: AlignmentKind;
  /** The tool id, for every kind but `undocumented-capability`. */
  tool: string | null;
  capability: ToolCapability | null;
  /** One sentence, already written for the author. */
  message: string;
  fix: AlignmentFix;
};

export type AlignmentInput = {
  /** Tool ids the body invokes or names. */
  prose: readonly string[];
  /**
   * Tool ids `allowed-tools` grants, or **null when the draft declares no list at all**.
   *
   * Null and `[]` are different facts and the distinction carries the whole feature: an empty
   * list is a grant of nothing and every prose tool is undeclared; *no list* means the author
   * has not written one, so there is nothing to disagree with yet and the panel offers to
   * generate one instead of reporting a dozen refusals that are not happening.
   */
  declared: readonly string[] | null;
  /** Capabilities R2.4 measured in the draft's bundled resources. */
  bundleCapabilities: readonly ToolCapability[];
  /** Whether the draft carries at least one `guardrail` block. */
  hasGuardrail: boolean;
  /** Whether the draft has any resources at all, so "no code" is not read as "no reach". */
  hasResources: boolean;
};

export type AlignmentReport = {
  findings: AlignmentFinding[];
  /** Tool ids the body names, for the panel's own summary. */
  prose: string[];
  declared: string[] | null;
  /**
   * `false` when the draft names no tools and ships no code — there was nothing to compare.
   *
   * *Nothing to compare* and *compared, and it agrees* are the same empty list and opposite
   * conclusions, and a green tick over the first is the failure this codebase keeps paying
   * for. The panel prints different sentences for them.
   */
  measured: boolean;
  /**
   * The `allowed-tools` line the SKILL.md export will carry — **what will be emitted**, not a
   * suggestion. The author's own list when they wrote one, the body's tools when they did not.
   * A panel that showed a proposal the export then ignored would be worse than showing none.
   */
  proposedAllowedTools: string;
};

/**
 * Compare the three sources. Pure: no database, no bundle, no model.
 *
 * The order of the rules is the order the panel shows them, and it is deliberate — a refused
 * call is something to act on, an over-broad grant is something to consider.
 */
export function alignTools(input: AlignmentInput): AlignmentReport {
  const findings: AlignmentFinding[] = [];
  const prose = [...new Set(input.prose)].sort();
  const declared = input.declared ? [...new Set(input.declared)].sort() : null;

  if (declared !== null) {
    for (const tool of prose) {
      if (declared.includes(tool)) continue;
      /*
       * `agent:bash` grants every CLI, so a shell grant answers for all of them. Reporting
       * `git`, `jq` and `sed` as ungranted under a blanket `Bash` would be three findings an
       * author cannot act on and would teach them to ignore the panel.
       */
      if (declared.includes("agent:bash") && toolById(tool)?.kind !== "agent-builtin") continue;
      findings.push({
        kind: "undeclared",
        tool,
        capability: null,
        message: `A step runs \`${toolLabel(tool)}\` and \`allowed-tools\` does not grant it.`,
        fix: "generate-allowed-tools",
      });
    }

    for (const tool of declared) {
      if (prose.includes(tool)) continue;
      // A shell grant covers CLIs the prose names, so it is used even if never named itself.
      if (tool === "agent:bash" && prose.some((id) => toolById(id)?.kind !== "agent-builtin")) continue;
      findings.push({
        kind: "unused",
        tool,
        capability: null,
        message: `\`allowed-tools\` grants \`${toolLabel(tool)}\` and nothing in the document uses it.`,
        fix: "none",
      });
    }
  }

  /*
   * A capability the bundle reaches that no named tool accounts for.
   *
   * Union of what the prose's tools imply, not a per-tool comparison: an author who documents
   * `curl` has documented network reach, and asking them to also name the library their script
   * imports would be a checklist rather than a finding.
   */
  const documented = new Set<ToolCapability>();
  for (const tool of prose) for (const cap of toolById(tool)?.capabilities ?? []) documented.add(cap);
  for (const capability of input.bundleCapabilities) {
    if (documented.has(capability)) continue;
    findings.push({
      kind: "undocumented-capability",
      tool: null,
      capability,
      message: `A bundled script reaches ${capability.replace("_", " ")} and no tool contract says so.`,
      fix: "add-tool-contract",
    });
  }

  /*
   * One finding for the whole draft, not one per tool.
   *
   * An author with no guardrail and six destructive tools has one thing to do, and six
   * identical rows would read as six problems. The tools are named inside the sentence so the
   * finding still says what it is about.
   */
  const destructive = destructiveAmong(prose).filter((id) => id !== "agent:bash");
  if (destructive.length > 0 && !input.hasGuardrail) {
    const names = destructive.map((id) => `\`${toolLabel(id)}\``).join(", ");
    findings.push({
      kind: "unguarded-destructive",
      tool: destructive[0],
      capability: null,
      message: `${names} can destroy data or change live state, and this draft states no constraint on using ${destructive.length > 1 ? "them" : "it"}.`,
      fix: "add-guardrail",
    });
  }

  return {
    findings,
    prose,
    declared,
    measured: prose.length > 0 || declared !== null || input.hasResources,
    proposedAllowedTools: renderAllowedTools(declared ?? prose),
  };
}

/**
 * The `allowed-tools` line a set of tool ids implies, in Claude Code's own spelling.
 *
 * Deterministic and sorted, because it lands in an exported file and R4.4's property is that
 * two exports of one draft are byte-identical. A built-in is written by name; a CLI becomes a
 * scoped `Bash(...)` grant, and one bare `Bash` is **not** emitted alongside them — a blanket
 * shell grant is broader than anything the document asked for, and quietly widening what a
 * consumer's agent may run is the opposite of what this feature is for.
 */
export function renderAllowedTools(toolIds: readonly string[]): string {
  const builtins: string[] = [];
  const commands: string[] = [];
  for (const id of [...new Set(toolIds)].sort()) {
    const tool = toolById(id);
    if (!tool) continue;
    if (tool.declaredAs) builtins.push(tool.declaredAs);
    else commands.push(`Bash(${tool.id}:*)`);
  }
  return [...builtins.sort(), ...commands.sort()].join(", ");
}
