import "server-only";

import { SEVERITY_WEIGHTS, substanceFactor } from "@/lib/quality";

/**
 * Runs the free analyzers over a draft document (Doc 2 R4.5).
 *
 * The same analyzers the corpus is judged by, on a bundle that exists only in memory —
 * `AnalyzerInput` takes files rather than a storage key, so a draft is judged before it has
 * been written anywhere. A builder that produced skills held to a lower standard than the
 * registry it publishes into would undermine both.
 *
 * The costly R2.3 consistency audit is not run here. It is opt-in for the corpus for the
 * same reason it should be opt-in here — and it compares documentation against *bundled
 * code*, which a text-only draft does not have.
 *
 * ## Why this is its own module
 *
 * It was a private function in `drafts.ts`. Blocks are now the source the body renders from,
 * so a block save has to re-validate the document it just produced — and `drafts.ts` imports
 * the block writer, so the block writer importing `drafts.ts` back would be a cycle. Same
 * split, for the same reason, as `dialects.ts` and `block-types.ts`: a shared thing moves to
 * a module both sides can reach rather than being copied to the second one.
 */

export type DraftValidation = {
  qualityScore: number;
  blocked: boolean;
  findings: Array<{ analyzer: string; reason: string; severity: string; message: string }>;
};

export async function validateDraftBody(input: {
  name: string;
  description: string;
  body: string;
  dialect: string;
}): Promise<DraftValidation> {
  const { runAnalyzersOnBundle } = await import("@/server/validation/run");

  const markdown = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body}\n`;
  const findings = await runAnalyzersOnBundle({
    files: [{ path: "SKILL.md", content: Buffer.from(markdown, "utf8") }],
    body: input.body,
    frontmatter: { name: input.name, description: input.description },
    markerPath: "SKILL.md",
    dialect: input.dialect,
    resolvedName: input.name,
    resolvedSummary: input.description,
    // We wrote the frontmatter ourselves from structured fields, so there is nothing to
    // have failed to parse. Null is the honest value, not a placeholder.
    parseError: null,
  });

  const penalty = findings.reduce(
    (total, f) => total + (SEVERITY_WEIGHTS[f.severity as keyof typeof SEVERITY_WEIGHTS] ?? 0),
    0,
  );
  const defectScore = Math.max(0, Math.min(100, 100 - penalty));
  const qualityScore = Math.round(
    defectScore * substanceFactor(Buffer.byteLength(input.body, "utf8")),
  );

  return {
    qualityScore,
    blocked: findings.some((f) => f.severity === "high" || f.severity === "critical"),
    findings,
  };
}
