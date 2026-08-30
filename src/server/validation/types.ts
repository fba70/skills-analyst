import "server-only";

import type { BundleFile } from "@/server/storage";

/**
 * The shape every analyzer speaks.
 *
 * Two rules make re-scan campaigns (Doc 2 R2.12) possible later: an analyzer always
 * reports its own version, and a finding always carries the evidence that produced it.
 * Bumping `version` is the selector for "re-judge everything this rule touched".
 */

export type VerdictResult = "pass" | "warn" | "fail" | "error";
export type VerdictSeverity = "info" | "low" | "medium" | "high" | "critical";

export type Finding = {
  /** Machine-readable, stable across versions, e.g. "missing-description". */
  reason: string;
  severity: VerdictSeverity;
  message: string;
  /** Where it was found. Never contains a secret in plaintext. */
  file?: string;
  line?: number;
  /** Short excerpt for a curator. Truncated, and rendered inert in the UI. */
  excerpt?: string;
};

export type AnalyzerOutput = {
  result: VerdictResult;
  findings: Finding[];
  /** Anything structured the analyzer wants to keep, e.g. a capability surface. */
  data?: Record<string, unknown>;
};

export type AnalyzerInput = {
  /** Every file in the bundle. */
  files: BundleFile[];
  /** The marker file's text, frontmatter stripped. */
  body: string;
  frontmatter: Record<string, unknown>;
  /** Bundle-relative path of the marker, e.g. "SKILL.md". */
  markerPath: string;
  /**
   * Which dialect this skill was authored in.
   *
   * Analyzers need it because the dialects do not share a contract. A SKILL.md without
   * frontmatter `name` has no identity and no trigger; an AGENTS.md without frontmatter is
   * simply an AGENTS.md — the format has none, and judging one against the other's rules
   * quarantined every AGENTS.md in the corpus.
   */
  dialect: string;
  /**
   * Identity as the normalizer resolved it, after its per-dialect fallbacks — frontmatter
   * first, then the leading heading, then the directory name.
   *
   * Analyzers should ask "does this skill have a name" rather than "does this YAML key
   * exist", which are the same question only for one dialect.
   */
  resolvedName: string | null;
  resolvedSummary: string | null;
  /**
   * Why the frontmatter block failed to parse, if it did.
   *
   * "Absent" and "malformed" are different faults with different fixes, and collapsing
   * them into `missing-name` sent authors hunting for a field that was in their file all
   * along.
   */
  parseError: string | null;
};

export type Analyzer = {
  name: string;
  /** Bump on ANY rule change — this is the re-scan selector. */
  version: string;
  /**
   * May return a promise. Rule-based analyzers stay synchronous; the LLM-assisted ones
   * (R2.3) cannot, and the runner awaits either.
   */
  run(input: AnalyzerInput): AnalyzerOutput | Promise<AnalyzerOutput>;
  /**
   * True when a run costs money or network.
   *
   * The runner excludes these unless a caller opts in, so the ordinary validate pass stays
   * free and re-runnable. Cost that is easy to trigger by accident ends up triggered by
   * accident.
   */
  readonly costly?: boolean;
};

/**
 * Fail closed.
 *
 * `fail` quarantines. So does `error`: an analyzer that crashed has not cleared the
 * skill, and treating a crash as a pass is exactly how a validation pipeline stops being
 * a trust boundary. `warn` is recorded and visible but does not block.
 */
export function blocks(result: VerdictResult): boolean {
  return result === "fail" || result === "error";
}

/** Highest severity wins when a single analyzer reports several findings. */
export function worstSeverity(findings: Finding[]): VerdictSeverity {
  const order: VerdictSeverity[] = ["info", "low", "medium", "high", "critical"];
  return findings.reduce<VerdictSeverity>(
    (worst, finding) =>
      order.indexOf(finding.severity) > order.indexOf(worst) ? finding.severity : worst,
    "info",
  );
}
