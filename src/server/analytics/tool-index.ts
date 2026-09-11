import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { resolveTool, resolveTools, type ToolEvidence } from "@/lib/tools";
import { db } from "@/server/db";
import { skills, skillStructures, skillTools, skillVersions } from "@/server/db/schema";

import { EXTRACTOR_VERSION } from "./structure";

/**
 * Reading the skill ↔ tool relation (Doc 7 RD.7, plan step P1).
 *
 * Every surface that answers *which tools does this skill run* reads through here — the
 * registry facet, the skill page, `/tools/<id>`, and the MCP filter — so the web and the agent
 * cannot disagree about it. RM.2's rule, which was written for MCP and holds for any second
 * reader.
 *
 * The write half is `resolveStoredTools` below: a pure re-resolution of the token counts
 * extraction already stored, so **widening the vocabulary costs a query rather than a
 * re-extract**. That is the whole reason `skill_structures.tool_refs` keeps the raw tokens.
 */

export type SkillTool = { tool: string; evidence: ToolEvidence; refCount: number };

/** The tools one version names, strongest evidence first. */
export async function toolsForVersion(skillVersionId: string): Promise<SkillTool[]> {
  const rows = await db
    .select({
      tool: skillTools.tool,
      evidence: skillTools.evidence,
      refCount: skillTools.refCount,
    })
    .from(skillTools)
    .where(
      and(
        eq(skillTools.skillVersionId, skillVersionId),
        eq(skillTools.extractorVersion, EXTRACTOR_VERSION),
      ),
    )
    .orderBy(skillTools.tool);
  return rows as SkillTool[];
}

/** The same, for a page of versions, so a listing needs one query rather than N. */
export async function toolsForVersions(ids: readonly string[]): Promise<Map<string, SkillTool[]>> {
  const out = new Map<string, SkillTool[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      skillVersionId: skillTools.skillVersionId,
      tool: skillTools.tool,
      evidence: skillTools.evidence,
      refCount: skillTools.refCount,
    })
    .from(skillTools)
    .where(
      and(
        // `inArray`, never `= any(${jsArray})`: drizzle renders a JS array in a template as a
        // row constructor, which Postgres refuses. Four call sites have shipped that bug.
        inArray(skillTools.skillVersionId, [...ids]),
        eq(skillTools.extractorVersion, EXTRACTOR_VERSION),
      ),
    )
    .orderBy(skillTools.tool);
  for (const row of rows) {
    const list = out.get(row.skillVersionId) ?? [];
    list.push({ tool: row.tool, evidence: row.evidence as ToolEvidence, refCount: row.refCount });
    out.set(row.skillVersionId, list);
  }
  return out;
}

/*
 * There is deliberately **no facet count in this module.**
 *
 * One lived here and was wrong in a way worth recording: it ran on the unscoped `db` handle
 * with a hard-coded `skills.org_id is null`, while `getFilterOptions` builds every other facet
 * inside `withOrgScope`. So a signed-in visitor would have had their own workspace's skills in
 * the filtered list and missing from the number beside it — a sidebar that disagrees with the
 * page it filters, which is the precise failure the capability facet's shared expression
 * exists to prevent.
 *
 * The count is `toolFacetRows` in `src/server/dal/skills.ts`, beside the facets it has to
 * agree with, scoped the way the DAL scopes everything. `/tools` reads it too, through
 * `toolDirectory`, so there is one answer to "how many skills use this" rather than two.
 * Same resolution as `getSkillsByIds` gaining `publicOnly` when the builder found this bug.
 */

/**
 * Coverage, printed above any table this produces.
 *
 * *Nothing uses `gh`* and *nothing has been resolved yet* are the same short list and opposite
 * conclusions — the `archetypes --blocks` misreading, in a new place. `unrecognisedShare` is
 * the other honest number: the share of distinct extracted tokens the vocabulary does **not**
 * name, which is what says whether this list is complete enough to filter on.
 */
export async function toolCoverage() {
  const [{ withTools }] = await db
    .select({ withTools: sql<number>`count(distinct ${skillTools.skillVersionId})::int` })
    .from(skillTools)
    .where(eq(skillTools.extractorVersion, EXTRACTOR_VERSION));

  /*
   * `resolved` counts versions that have been **looked at**, not versions that produced a row.
   * Those are different numbers — 28,035 versions name no recognised tool — and conflating
   * them is what made the resolver loop for ever and what would make the skill page say
   * "not measured yet" about a document it had measured and found nothing in.
   */
  const [{ fingerprinted, withRefs, resolved }] = await db
    .select({
      fingerprinted: sql<number>`count(*)::int`,
      withRefs: sql<number>`count(*) filter (where ${skillStructures.toolRefs} <> '{}'::jsonb)::int`,
      resolved: sql<number>`count(*) filter (where ${skillStructures.toolsResolvedAt} is not null)::int`,
    })
    .from(skillStructures)
    .where(eq(skillStructures.extractorVersion, EXTRACTOR_VERSION));

  /*
   * The distinct tokens come back and are resolved **in JS, through the real resolver**.
   *
   * The alternative is a `where key = any(array[…])` built from `TOOL_IDS`, which is a second
   * copy of the vocabulary written in SQL — it would drift the first time an alias is added,
   * and it would report a share that disagrees with what the facet actually stores. Measuring
   * a gate with something that is not the gate is the mistake this codebase made twice in one
   * afternoon. Nine thousand rows is nothing to pull.
   */
  const { rows: tokens } = await db.execute<{ token: string; refs: number }>(sql`
    select t.key as token, sum((t.value)::int)::int as refs
      from skill_structures s, jsonb_each_text(s.tool_refs) t
     where s.extractor_version = ${EXTRACTOR_VERSION}
     group by t.key
  `);
  const isNamed = (token: string) =>
    resolveTool(token, "code") !== null || resolveTool(token, "frontmatter") !== null;
  const total = tokens.length;
  const named = tokens.filter((t) => isNamed(t.token)).length;
  const totalRefs = tokens.reduce((sum, t) => sum + t.refs, 0);
  const namedRefs = tokens.filter((t) => isNamed(t.token)).reduce((sum, t) => sum + t.refs, 0);
  return {
    extractorVersion: EXTRACTOR_VERSION,
    fingerprinted,
    /** Versions whose extraction found at least one candidate token. */
    withRefs,
    /** Versions examined, whether or not the vocabulary named anything in them. */
    resolved,
    /** Versions that produced at least one row. Always the smaller number. */
    withTools,
    distinctTokens: total,
    namedTokens: named,
    /**
     * Share of **distinct tokens** no entry names — 98.7%, and on its own that number is a
     * lie about this vocabulary. The tail is 9,316 one-off strings: misparsed prose, package
     * names, a repository's private script. Printed alone it says the list has failed.
     */
    unrecognisedShare: total > 0 ? Math.round(((total - named) / total) * 1000) / 10 : 0,
    totalRefs,
    namedRefs,
    /**
     * Share of **references** the vocabulary resolves — 52% of 345,598, and this is the one a reader
     * experiences, because a token appearing in 300 repositories counts 300 times here and
     * once above. Both are reported, and the caller leads with this one: a rate whose
     * denominator answers a different question from the one being asked is the mistake this
     * codebase made with label *share* against labels-per-skill, and it inverted a conclusion.
     */
    refShare: totalRefs > 0 ? Math.round((namedRefs / totalRefs) * 1000) / 10 : 0,
  };
}

export type ResolveReport = {
  versions: number;
  rows: number;
  unrecognised: number;
};

/**
 * Turn the stored token counts into rows, for every version at the current extractor version.
 *
 * **Pure re-resolution: no bundle is read and no model is called.** Extraction already did the
 * expensive half, so widening `TOOLS` is `pnpm structures --resolve-tools` and a minute, not
 * another 2.5-hour pass. That is what the raw jsonb is kept for.
 *
 * Bounded and resumable like every other derived stage: `limit` rows per call, skipping
 * versions already resolved unless `force`.
 */
/**
 * Hand the whole corpus back to the resolver — what a widened vocabulary needs.
 *
 * Clearing the marker rather than passing a `force` flag down every pass, because the flag
 * only works on the first one: by the second, everything it touched is marked and the drain
 * stops having done a single batch. Clear once, then drain normally.
 */
export async function clearToolResolution(): Promise<number> {
  const { rowCount } = await db.execute(sql`
    update skill_structures
       set tools_resolved_at = null
     where extractor_version = ${EXTRACTOR_VERSION}
       and tools_resolved_at is not null
  `);
  return rowCount ?? 0;
}

export async function resolveStoredTools(
  options: { limit?: number; force?: boolean } = {},
): Promise<ResolveReport & { remaining: number }> {
  const limit = options.limit ?? 2000;

  const { rows } = await db.execute<{
    skill_version_id: string;
    skill_id: string;
    org_id: string | null;
    tool_refs: Record<string, number>;
    allowed_tools: string[];
  }>(sql`
    select s.skill_version_id, s.skill_id, s.org_id, s.tool_refs, s.allowed_tools
      from skill_structures s
     where s.extractor_version = ${EXTRACTOR_VERSION}
       ${options.force ? sql`` : sql`and s.tools_resolved_at is null`}
     limit ${limit}
  `);

  const report: ResolveReport = { versions: 0, rows: 0, unrecognised: 0 };

  /*
   * Batched, because the obvious shape is a transaction per version and there are 47,854 of
   * them — one round trip each to a database on the other side of a network, which is the
   * sequential-bundle-read mistake `concurrency.ts` documents, in a cheaper disguise. Public
   * rows are almost all of the corpus and need no scope set, so they go one delete and one
   * multi-row insert per batch; an org-scoped row still gets its own transaction, because
   * `SET LOCAL app.org_id` is per transaction and mixing tenants in one would be wrong.
   */
  const publicPending: Array<typeof skillTools.$inferInsert> = [];
  const publicVersionIds: string[] = [];

  async function flushPublic(): Promise<void> {
    if (publicVersionIds.length === 0) return;
    await db.transaction(async (tx) => {
      await tx
        .delete(skillTools)
        .where(
          and(
            inArray(skillTools.skillVersionId, publicVersionIds),
            eq(skillTools.extractorVersion, EXTRACTOR_VERSION),
          ),
        );
      if (publicPending.length > 0) await tx.insert(skillTools).values(publicPending);
      /*
       * The marker is written in the **same transaction** as the rows, and for every version
       * in the batch whether or not it produced any. A version that names no recognised tool
       * is resolved, not pending; marking only the ones with rows is the loop this column
       * exists to end.
       */
      await tx
        .update(skillStructures)
        .set({ toolsResolvedAt: new Date() })
        .where(
          and(
            inArray(skillStructures.skillVersionId, publicVersionIds),
            eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
          ),
        );
    });
    publicPending.length = 0;
    publicVersionIds.length = 0;
  }

  for (const row of rows) {
    /*
     * Evidence is reconstructed from the two stored columns rather than from a third: a token
     * in `allowed_tools` was declared, everything else in `tool_refs` was invoked or mentioned.
     * The extractor's finer `code` / `prose` split is not stored per token — it is a probe-time
     * diagnostic — so an undeclared reference is recorded as `code`, which is the claim the
     * stored data can actually support. Saying `prose` would be inventing precision.
     */
    const declared = new Set((row.allowed_tools ?? []).map((t) => t.toLowerCase()));
    const refs: Array<{ token: string; evidence: ToolEvidence }> = [];
    /*
     * Counts are summed per **resolved id**, not per token, or an alias loses them: `python3`
     * is 238 repositories and `python` 199, and keying on the token would file the larger half
     * under a name the vocabulary does not store and then report `python` as seen once.
     */
    const counts = new Map<string, number>();
    for (const [token, n] of Object.entries(row.tool_refs ?? {})) {
      const evidence: ToolEvidence = declared.has(token.toLowerCase()) ? "frontmatter" : "code";
      refs.push({ token, evidence });
      const id = resolveTool(token, evidence);
      if (id) counts.set(id, (counts.get(id) ?? 0) + (typeof n === "number" ? n : 0));
    }

    const { tools, unrecognised } = resolveTools(refs);
    report.versions += 1;
    report.unrecognised += unrecognised.length;
    report.rows += tools.length;

    const values = tools.map((tool) => ({
      orgId: row.org_id,
      skillId: row.skill_id,
      skillVersionId: row.skill_version_id,
      extractorVersion: EXTRACTOR_VERSION,
      tool: tool.id,
      evidence: tool.evidence,
      refCount: counts.get(tool.id) ?? 1,
    }));

    if (!row.org_id) {
      publicVersionIds.push(row.skill_version_id);
      publicPending.push(...values);
      /*
       * Flushed on **rows**, not on versions, and that is the bound that matters: a bind
       * parameter limit is 65,535 and each row carries eight, so a version-count trigger would
       * be fine at the corpus's ~2 tools a skill and would blow up on a batch of documents
       * that each name twenty. 2,000 rows is 16,000 parameters, with room to spare.
       */
      if (publicPending.length >= 2_000 || publicVersionIds.length >= 500) await flushPublic();
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${row.org_id}, true)`);
      await tx
        .delete(skillTools)
        .where(
          and(
            eq(skillTools.skillVersionId, row.skill_version_id),
            eq(skillTools.extractorVersion, EXTRACTOR_VERSION),
          ),
        );
      if (values.length > 0) await tx.insert(skillTools).values(values);
      await tx
        .update(skillStructures)
        .set({ toolsResolvedAt: new Date() })
        .where(
          and(
            eq(skillStructures.skillVersionId, row.skill_version_id),
            eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
          ),
        );
    });
  }

  await flushPublic();

  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(skillStructures)
    .where(
      and(
        eq(skillStructures.extractorVersion, EXTRACTOR_VERSION),
        sql`${skillStructures.toolsResolvedAt} is null`,
      ),
    );

  return { ...report, remaining };
}

/** Versions resolved at the current extractor version, for the CLI's status line. */
export async function resolvedCount(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(distinct ${skillTools.skillVersionId})::int` })
    .from(skillTools)
    .where(eq(skillTools.extractorVersion, EXTRACTOR_VERSION));
  return n;
}

/** Versions of skills the registry serves, for a listing's tool chips. */
export async function currentVersionIdsFor(skillIds: readonly string[]): Promise<string[]> {
  if (skillIds.length === 0) return [];
  const rows = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.currentVersionId, skillVersions.id))
    .where(inArray(skills.id, [...skillIds]));
  return rows.map((r) => r.id);
}
