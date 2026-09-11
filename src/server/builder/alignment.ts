import "server-only";

import { alignTools, type AlignmentReport } from "@/lib/alignment";
import { declaresAllowedTools, extractToolRefs } from "@/lib/tool-refs";
import { resolveTool, type ToolCapability } from "@/lib/tools";
import { extractStructure } from "@/server/analytics/structure";
import type { BundleFile } from "@/server/storage";

import { getDraft } from "./drafts";
import { listDraftResources } from "./improve";

/**
 * Contract alignment for one draft (Doc 7 RD.8, plan step P2).
 *
 * ## One instrument, not a second detector
 *
 * The tools a draft names are read by **`extractStructure` itself** — the same function that
 * produced all 1.6 million corpus blocks and all 50,965 tool-reference rows — over a synthetic
 * bundle built from the draft's body and its resources. `blockDeviations` takes exactly this
 * shape and says why: a second, lighter reader would drift, and every drift would surface as a
 * finding the author cannot act on, because the panel would be describing a document the
 * extractor does not see.
 *
 * That also means the comparison and the registry facet answer with one vocabulary. A draft
 * that shows `kubectl` here is a draft that would show `kubectl` on its skill page once
 * published.
 *
 * ## The bundle is real, because R2.4 needs it to be
 *
 * `draft_resources` (C6) is what makes the third source possible at all: without files there
 * is no code, and *no code* must not be reported as *no reach*. The capability analyzer runs
 * over the same bundle, so "a bundled script reaches the network" is measured rather than
 * guessed — and `hasResources` travels into the report so the panel can tell a draft with no
 * files from one whose files are clean.
 */
/**
 * The tool ids a draft's export should declare, and whether the author wrote them.
 *
 * Pure — body and frontmatter in, ids out — so `buildDraftArchive` can call it without a
 * database and R4.4's byte-identical-repeat property survives. **The panel and the export read
 * this same function**, which is the only way the sentence *"this is what your export will
 * carry"* can be true; `verify:tool-alignment` asserts the two agree on a real draft.
 */
export function declaredOrDerivedTools(
  body: string,
  frontmatter: Record<string, unknown>,
): { ids: string[]; declared: boolean } {
  const files: BundleFile[] = [{ path: "SKILL.md", content: Buffer.from(body, "utf8") }];
  const fingerprint = extractStructure({ body, frontmatter, files, markerPath: "SKILL.md" });

  if (declaresAllowedTools(frontmatter)) {
    const ids = [
      ...new Set(
        fingerprint.allowedTools
          .map((token) => resolveTool(token, "frontmatter"))
          .filter((id): id is string => id !== null),
      ),
    ];
    return { ids, declared: true };
  }

  const { refs } = extractToolRefs({
    frontmatter,
    segments: fingerprint.blocks.map((block) => ({
      kind: block.features.kind === "code" ? ("code" as const) : ("prose" as const),
      language: block.features.codeLanguage,
      text: body.slice(block.startChar, block.endChar),
    })),
  });
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.source === "frontmatter") continue;
    const id = resolveTool(ref.token, "code");
    if (id) ids.add(id);
  }
  return { ids: [...ids], declared: false };
}

export async function alignmentForDraft(
  draftId: string,
  orgId: string,
): Promise<AlignmentReport | null> {
  const draft = await getDraft(draftId, orgId);
  if (!draft) return null;

  const body = draft.body ?? "";
  const resources = await listDraftResources(draftId, orgId);
  const files: BundleFile[] = [
    { path: "SKILL.md", content: Buffer.from(body, "utf8") },
    ...resources.map((resource) => ({
      path: resource.path,
      content: Buffer.from(resource.content, "utf8"),
    })),
  ];

  const frontmatter = (draft.frontmatter ?? {}) as Record<string, unknown>;
  const fingerprint = extractStructure({ body, frontmatter, files, markerPath: "SKILL.md" });

  /*
   * The per-source split, which `skill_structures.tool_refs` deliberately does not store —
   * that column is a merged count, and merging is exactly what this feature must not do. A
   * tool named in a step and a tool granted in frontmatter are the two halves of the
   * disagreement, so they are re-derived here from the same segments the fingerprint used.
   */
  const { refs } = extractToolRefs({
    frontmatter,
    segments: fingerprint.blocks.map((block) => ({
      kind: block.features.kind === "code" ? ("code" as const) : ("prose" as const),
      language: block.features.codeLanguage,
      text: body.slice(block.startChar, block.endChar),
    })),
  });

  const prose = new Set<string>();
  for (const ref of refs) {
    if (ref.source === "frontmatter") continue;
    const id = resolveTool(ref.token, "code");
    if (id) prose.add(id);
  }

  /*
   * Absent and empty are different facts, so the key is asked about rather than the list
   * counted. `allowedToolsOf` returns `[]` for both, and reporting every step as refused
   * against a list the author never wrote would be a dozen findings about nothing.
   */
  const declared = declaresAllowedTools(frontmatter)
    ? [
        ...new Set(
          fingerprint.allowedTools
            .map((token) => resolveTool(token, "frontmatter"))
            .filter((id): id is string => id !== null),
        ),
      ]
    : null;

  const hasGuardrail = (fingerprint.blockCounts.guardrail ?? 0) > 0;

  return alignTools({
    prose: [...prose],
    declared,
    bundleCapabilities: await bundleCapabilities({ body, frontmatter, files, dialect: draft.dialect }),
    hasGuardrail,
    hasResources: resources.length > 0,
    // Looked up only when it could be shown, so a draft that already has a guardrail costs
    // no query at all.
    guardrailEvidence: hasGuardrail ? null : await guardrailEvidenceFor([...prose]),
  });
}

/**
 * The corpus share behind RD.8's sentence, for the best-evidenced destructive tool named.
 *
 * The **best-evidenced**, not the first: a draft naming two destructive tools where only one
 * clears the gate should quote that one, and picking the first would be a number chosen by
 * array order. `null` whenever nothing clears it, which is most tools — six of twenty-four do
 * on this corpus — and the sentence reads correctly without it.
 */
async function guardrailEvidenceFor(
  prose: readonly string[],
): Promise<{ tool: string; share: number; skills: number; sources: number } | null> {
  const { destructiveAmong } = await import("@/lib/tools");
  const candidates = destructiveAmong(prose).filter((id) => id !== "agent:bash");
  if (candidates.length === 0) return null;

  try {
    const { guardrailPrevalenceFor } = await import("@/server/analytics/tools-mine");
    let best: { tool: string; share: number; skills: number; sources: number } | null = null;
    for (const tool of candidates) {
      const evidence = await guardrailPrevalenceFor(tool);
      if (evidence && (best === null || evidence.sources > best.sources)) {
        best = { tool, ...evidence };
      }
    }
    return best;
  } catch {
    // The panel is worth more than the number; a missing table must not empty the card.
    return null;
  }
}

/**
 * What R2.4 measures the draft's own code reaching.
 *
 * The capability analyzer is called directly rather than through `runAnalyzersOnBundle`,
 * because that seam returns findings and this needs the *surface* — the `data.capabilities`
 * list, which is the measurement rather than the complaint. Its own findings still reach the
 * author through R4.5 at publish; nothing here duplicates or pre-empts them.
 *
 * It never throws into the panel: an analyzer that cannot read a resource is our problem, and
 * an empty surface is the honest answer while `hasResources` says whether there was anything
 * to read.
 */
async function bundleCapabilities(input: {
  body: string;
  frontmatter: Record<string, unknown>;
  files: BundleFile[];
  dialect: string;
}): Promise<ToolCapability[]> {
  if (input.files.length <= 1) return [];
  try {
    const { capabilitySurface } = await import("@/server/validation/analyzers/capability-surface");
    const output = await capabilitySurface.run({
      files: input.files,
      body: input.body,
      frontmatter: input.frontmatter,
      markerPath: "SKILL.md",
      dialect: input.dialect,
      resolvedName: "",
      resolvedSummary: "",
      // The draft's frontmatter was parsed by the builder, not by us; there is no parse to fail.
      parseError: null,
    });
    const data = output.data as { capabilities?: string[] } | undefined;
    return (data?.capabilities ?? []) as ToolCapability[];
  } catch {
    return [];
  }
}
