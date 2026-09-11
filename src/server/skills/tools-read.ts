import "server-only";

import type { ToolEvidence } from "@/lib/tools";

/**
 * One reader for *which tools does this skill name*, shared by the web page and MCP (Doc 7
 * RD.7, RM.2).
 *
 * A thin wrapper over `analytics/tool-index`, and it exists for two reasons rather than as a
 * pass-through:
 *
 * 1. **It answers the question the surfaces actually ask**, which is not "what rows are
 *    there" but "what rows are there *and* has anything been resolved for this version" —
 *    the two empty states are different sentences and every caller needs both.
 * 2. **It degrades honestly while `skill_tools` does not exist.** The table arrives with a
 *    migration; until it is applied, `42P01` would take down a public skill page over a
 *    facet. Only that code is caught, and only into `resolved: false`, which renders as *not
 *    measured yet* — never as *this skill names no tools*. Any other error is the caller's.
 */

export type ToolView = {
  tools: Array<{ tool: string; evidence: ToolEvidence; refCount: number }>;
  /** False when nothing has been resolved for this version — including a table that is absent. */
  resolved: boolean;
};

/** Postgres `undefined_table`. Drizzle wraps the driver error; the code lives on `.cause`. */
function isMissingTable(error: unknown): boolean {
  return (error as { cause?: { code?: string } })?.cause?.code === "42P01";
}

export async function toolViewForVersion(skillVersionId: string): Promise<ToolView> {
  try {
    const { toolsForVersion } = await import("@/server/analytics/tool-index");
    const tools = await toolsForVersion(skillVersionId);
    if (tools.length > 0) return { tools, resolved: true };

    /*
     * No rows is ambiguous on its own, so it costs one more query to disambiguate: a version
     * that produced no *candidate tokens* at all genuinely names no tools, while one that has
     * simply not been through `--resolve-tools` has not been measured. Only paid when the
     * list is empty, which is the case where the answer matters.
     */
    const { toolCoverage } = await import("@/server/analytics/tool-index");
    const coverage = await toolCoverage();
    return { tools: [], resolved: coverage.resolved > 0 };
  } catch (error) {
    if (isMissingTable(error)) return { tools: [], resolved: false };
    throw error;
  }
}

/** The same, for a page of versions. One query, then the same coverage question once. */
export async function toolViewsForVersions(
  ids: readonly string[],
): Promise<{ byVersion: Map<string, ToolView["tools"]>; resolved: boolean }> {
  if (ids.length === 0) return { byVersion: new Map(), resolved: true };
  try {
    const { toolCoverage, toolsForVersions } = await import("@/server/analytics/tool-index");
    const [byVersion, coverage] = await Promise.all([toolsForVersions(ids), toolCoverage()]);
    return { byVersion, resolved: coverage.resolved > 0 };
  } catch (error) {
    if (isMissingTable(error)) return { byVersion: new Map(), resolved: false };
    throw error;
  }
}

/**
 * Facet counts and coverage for `/tools`, with the same refusal to crash on an absent table.
 *
 * The counts come from **the DAL's facet, the one the registry sidebar uses**, rather than a
 * second query of its own. There were briefly two — an unscoped one here pinning
 * `org_id is null`, and the scoped one beside the other facets — and two counts of one thing
 * drift: a signed-in visitor would have seen their own org's skills on `/skills` and not in
 * the tally on `/tools`. The fix is the one `getSkillsByIds` already made when the builder
 * found this exact scope bug: one function, and the scope resolved where scope belongs.
 *
 * `/tools` therefore shows the same population `/skills` does — same registry underneath,
 * which is the whole argument for the `(public)` group reading through the DAL at all.
 */
/**
 * Which block types are worth quoting *about a tool*, best first (Doc 7 RD.9).
 *
 * Not every type says something about a tool. An `example` or a `glossary` entry from a skill
 * that happens to run `git` is evidence about that skill, not about `git` — so the list is the
 * three types whose subject *is* using something: the contract that invokes it, the constraint
 * on invoking it, and the steps around it.
 *
 * A destructive tool leads with the guardrail, because that is the question RD.8 sends a reader
 * here to answer: their draft names `rm` and carries no constraint, and this page is what good
 * skills say about that.
 */
const EVIDENCE_TYPES = ["tool-contract", "guardrail", "procedure"] as const;

export type ToolEvidenceGroup = {
  type: (typeof EVIDENCE_TYPES)[number];
  result: Awaited<ReturnType<typeof import("@/server/analytics/block-library").libraryFragments>>;
};

/**
 * Real passages from skills that name one tool, for `/tools/<id>`.
 *
 * Goes through `libraryFragments` with `tool` set and **no category** — the whole corpus,
 * because *what does a good guardrail about `git` look like* is not a question about `review`
 * skills. That is one more `where` on the library's own query, so every refusal it makes still
 * holds: the licence gate, one fragment per source, near-duplicates excluded, the word bounds.
 *
 * Three types at two fragments each. A page that listed every type would bury the one a reader
 * came for, and the cap is the same restraint the library's own `MAX_FRAGMENTS` shows.
 */
export async function toolEvidence(
  toolId: string,
  destructive: boolean,
): Promise<{ groups: ToolEvidenceGroup[]; available: boolean }> {
  const order = destructive
    ? (["guardrail", "tool-contract", "procedure"] as const)
    : EVIDENCE_TYPES;
  try {
    const { libraryFragments } = await import("@/server/analytics/block-library");
    const groups: ToolEvidenceGroup[] = [];
    for (const type of order) {
      const result = await libraryFragments({ type, tool: toolId, limit: 2 });
      if (result.fragments.length > 0) groups.push({ type, result });
    }
    return { groups, available: true };
  } catch (error) {
    if (isMissingTable(error)) return { groups: [], available: false };
    throw error;
  }
}

export async function toolDirectory() {
  try {
    const { toolCoverage } = await import("@/server/analytics/tool-index");
    const { toolFacetRows } = await import("@/server/dal/skills");
    const [rows, coverage] = await Promise.all([toolFacetRows(), toolCoverage()]);
    const counts = rows.map((row) => ({ tool: row.value, skills: row.count }));
    return { counts, coverage, available: true as const };
  } catch (error) {
    if (isMissingTable(error)) {
      return { counts: [], coverage: null, available: false as const };
    }
    throw error;
  }
}
