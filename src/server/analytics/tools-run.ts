import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ingestPolicy } from "@/server/crawl/policy";
import { db } from "@/server/db";
import { skills, skillStructures, skillVersions } from "@/server/db/schema";
import { mapWithConcurrency } from "@/server/lib/concurrency";
import { splitFrontmatter } from "@/server/skills/normalize";
import { REVIEW_FLOOR } from "@/server/taxonomy/vocabulary";
import { loadBundle, type VersionProvenance } from "@/server/validation/bundle-loader";

import { extractToolRefs } from "@/lib/tool-refs";

import { extractBlocks } from "./blocks";
import { EXTRACTOR_VERSION, extractStructure } from "./structure";

/**
 * Tool references: a dry run over real bundles, and the stored-row summary (Doc 7 step P0).
 *
 * Doc 7 §4 says the tool vocabulary is **seeded from a corpus count, not from memory**, and
 * this is the count. Two ways to get it, and they answer at different times:
 *
 * - `probeTools` reads real bundles and **writes nothing** — the answer today, over a random
 *   sample, at whatever extractor version is in the source tree. It is how the frequency table
 *   is read *before* a 2.5-hour re-extract is spent, and how a change to `tool-refs.ts` is
 *   judged before it lands on fifty thousand rows.
 * - `toolRefSummary` reads what extraction stored. Empty until the re-extract at 2.1.0 has run,
 *   and it says so with the coverage number first, because a short table over 3% of the corpus
 *   reads as a quiet corpus.
 *
 * `decisionRuleCoverage` is the other half of P0 — how many skills per category carry a
 * decision rule at all — and it needs no re-extract: `block_counts` has been stored since 2.0.0,
 * so it reads the newest extractor version that *has* rows and names which one. A bumped
 * version must not look like data loss.
 */

export type ToolProbeReport = {
  versions: number;
  failed: number;
  /** Skills whose frontmatter declares `allowed-tools`, whatever it says. */
  withAllowedTools: number;
  /** Skills with at least one tool reference from any source. */
  withAnyTool: number;
  /**
   * Per token: how many skills and how many distinct *repositories* reference it, how many
   * references, and from which sources. Repositories, because a generator shipping eighteen
   * skills that all call one CLI is one data point about the corpus and eighteen about the
   * generator — R3.4's distinct-structures argument, at token scale.
   */
  tokens: Array<{
    token: string;
    skills: number;
    sources: number;
    refs: number;
    code: number;
    prose: number;
    frontmatter: number;
  }>;
  /** Version pins, most common first. */
  pins: Array<{ tool: string; version: string; skills: number }>;
  /** Skills with at least one decision-rule block, and the mean count among those. */
  decisionRules: { skills: number; meanPerSkill: number };
  /** Lines and spans that produced `sampleToken`. Local diagnostic; never stored. */
  samples: string[];
};

export type ToolProbeOptions = {
  limit?: number;
  /** Restrict to one function category. */
  category?: string;
  /**
   * Collect the excerpts behind one token. A distribution cannot tell you a token is coming
   * from the wrong place — only reading a dozen of its lines can, and the first probe's head
   * entry was the fence delimiter.
   */
  sampleToken?: string;
};

export async function probeTools(options: ToolProbeOptions = {}): Promise<ToolProbeReport> {
  const limit = options.limit ?? 200;

  const rows = options.category
    ? ((
        await db.execute(sql`
          select sv.id, sv.source_id, sv.content_hash, sv.content_stored, sv.provenance
          from skill_categories c
          join skills sk on sk.id = c.skill_id
          join skill_versions sv on sv.id = sk.current_version_id
          where c.axis = 'function' and c.value = ${options.category}
            and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
            and sk.status = 'indexed' and sk.canonical_skill_id is null
          order by random()
          limit ${limit}
        `)
      ).rows as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        sourceId: r.source_id as string,
        contentHash: r.content_hash as string,
        contentStored: Boolean(r.content_stored),
        provenance: r.provenance as VersionProvenance,
      }))
    : await db
        .select({
          id: skillVersions.id,
          sourceId: skillVersions.sourceId,
          contentHash: skillVersions.contentHash,
          contentStored: skillVersions.contentStored,
          provenance: skillVersions.provenance,
        })
        .from(skillVersions)
        .innerJoin(skills, eq(skills.id, skillVersions.skillId))
        .where(and(eq(skills.status, "indexed"), inArray(skillVersions.status, ["indexed"])))
        .orderBy(sql`random()`)
        .limit(limit);

  const tokens = new Map<
    string,
    { skills: number; sources: Set<string>; refs: number; code: number; prose: number; frontmatter: number }
  >();
  const pins = new Map<string, number>();
  const report: ToolProbeReport = {
    versions: 0,
    failed: 0,
    withAllowedTools: 0,
    withAnyTool: 0,
    tokens: [],
    pins: [],
    decisionRules: { skills: 0, meanPerSkill: 0 },
    samples: [],
  };
  let decisionRuleBlocks = 0;

  await mapWithConcurrency(rows, ingestPolicy.bundleConcurrency, async (row) => {
    try {
      const { files } = await loadBundle({
        contentStored: row.contentStored,
        contentHash: row.contentHash,
        tier: "public",
        provenance: row.provenance as VersionProvenance,
      });
      const marker = files.find((f) => /^(SKILL|AGENTS)\.md$/i.test(f.path)) ?? files[0];
      if (!marker) {
        report.failed += 1;
        return;
      }
      const { frontmatter, body } = splitFrontmatter(marker.content.toString("utf8"));
      const fingerprint = extractStructure({ files, body, frontmatter, markerPath: marker.path });

      report.versions += 1;
      if (fingerprint.allowedTools.length > 0) report.withAllowedTools += 1;
      if (Object.keys(fingerprint.toolRefs).length > 0) report.withAnyTool += 1;

      const rules = fingerprint.blockCounts["decision-rule"] ?? 0;
      if (rules > 0) {
        report.decisionRules.skills += 1;
        decisionRuleBlocks += rules;
      }

      /*
       * The per-source split and the excerpts are re-derived here rather than stored: the
       * stored column is the count, and both are probe-time diagnostics for deciding what the
       * vocabulary should recognise. Same function the extractor called, over the same
       * segments, so this cannot disagree with the count it explains.
       */
      const blocks = extractBlocks({
        body,
        headings: fingerprint.headings,
        bundlePaths: new Set(files.map((f) => f.path.replace(/^\.\//, ""))),
      });
      const { refs } = extractToolRefs({
        frontmatter,
        segments: blocks.map((block) => ({
          kind: block.features.kind === "code" ? ("code" as const) : ("prose" as const),
          language: block.features.codeLanguage,
          text: body.slice(block.startChar, block.endChar),
        })),
      });

      const seen = new Set<string>();
      for (const ref of refs) {
        const entry =
          tokens.get(ref.token) ??
          { skills: 0, sources: new Set<string>(), refs: 0, code: 0, prose: 0, frontmatter: 0 };
        entry.refs += 1;
        entry[ref.source] += 1;
        entry.sources.add(row.sourceId);
        if (!seen.has(ref.token)) {
          seen.add(ref.token);
          entry.skills += 1;
        }
        tokens.set(ref.token, entry);
        if (options.sampleToken === ref.token && report.samples.length < 14) {
          report.samples.push(`${ref.source.padEnd(11)} ${ref.excerpt}`);
        }
      }
      for (const pin of fingerprint.versionPins) {
        const key = `${pin.tool}@${pin.version}`;
        pins.set(key, (pins.get(key) ?? 0) + 1);
      }
    } catch {
      // Counted, not thrown — same posture as the extractor: a bundle that will not load is a
      // coverage problem, and this one does not even write.
      report.failed += 1;
    }
  });

  report.tokens = [...tokens.entries()]
    .map(([token, entry]) => ({ token, ...entry, sources: entry.sources.size }))
    .sort((a, b) => b.sources - a.sources || b.skills - a.skills || a.token.localeCompare(b.token));
  report.pins = [...pins.entries()]
    .map(([key, count]) => {
      const at = key.lastIndexOf("@");
      return { tool: key.slice(0, at), version: key.slice(at + 1), skills: count };
    })
    .sort((a, b) => b.skills - a.skills || a.tool.localeCompare(b.tool));
  report.decisionRules.meanPerSkill =
    report.decisionRules.skills > 0
      ? Math.round((decisionRuleBlocks / report.decisionRules.skills) * 10) / 10
      : 0;

  return report;
}

/**
 * The stored frequency table at the current extractor version, with coverage first.
 *
 * `tool_refs` is `{}` on every row written before 2.1.0, so until the re-extract has run this
 * is honestly empty — and the caller prints `fingerprinted of eligible` above the table so an
 * empty or short one cannot be read as a quiet corpus.
 */
export async function toolRefSummary(limit = 60) {
  const [{ fingerprinted }] = await db
    .select({ fingerprinted: sql<number>`count(*)::int` })
    .from(skillStructures)
    .where(eq(skillStructures.extractorVersion, EXTRACTOR_VERSION));

  const [{ eligible }] = await db
    .select({ eligible: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(inArray(skillVersions.status, ["indexed", "quarantined"]));

  const { rows: tokens } = await db.execute<{ token: string; skills: number; refs: number }>(sql`
    select t.key as token,
           count(*)::int as skills,
           sum((t.value)::int)::int as refs
      from skill_structures s,
           jsonb_each_text(s.tool_refs) t
     where s.extractor_version = ${EXTRACTOR_VERSION}
     group by t.key
     order by skills desc, refs desc, t.key
     limit ${limit}
  `);

  const { rows: pins } = await db.execute<{ tool: string; version: string; skills: number }>(sql`
    select p->>'tool' as tool, p->>'version' as version, count(*)::int as skills
      from skill_structures s,
           jsonb_array_elements(s.version_pins) p
     where s.extractor_version = ${EXTRACTOR_VERSION}
     group by 1, 2
     order by skills desc, tool, version
     limit ${limit}
  `);

  const [{ withAllowedTools, withAnyTool }] = await db
    .select({
      withAllowedTools: sql<number>`count(*) filter (where cardinality(${skillStructures.allowedTools}) > 0)::int`,
      withAnyTool: sql<number>`count(*) filter (where ${skillStructures.toolRefs} <> '{}'::jsonb)::int`,
    })
    .from(skillStructures)
    .where(eq(skillStructures.extractorVersion, EXTRACTOR_VERSION));

  return {
    extractorVersion: EXTRACTOR_VERSION,
    fingerprinted,
    eligible,
    withAllowedTools,
    withAnyTool,
    tokens,
    pins,
  };
}

/**
 * Hand a corrupt fingerprint back to the extractor, by deleting it.
 *
 * A count that is not a number cannot be repaired by patching the value: the true count is
 * whatever the document says, and reasoning it out of the corruption string ("it ends in 1, so
 * it was one occurrence") is the guess this codebase re-derives instead of making. The selector
 * already picks up any version with **no** fingerprint at the current extractor version, so the
 * repair is to remove the row and let `--extract` do what it does.
 *
 * Idempotent, and a no-op once the cause is fixed: `extractToolRefs` counts in a `Map`, so
 * nothing can write a non-numeric count again. `verify:tool-refs` asserts zero such rows, which
 * is what makes this command findable when it is next needed.
 *
 * The version's `skill_blocks` rows are left in place and are briefly orphaned — the extractor
 * deletes and re-inserts them in the same transaction as the fingerprint, so run `--extract`
 * straight afterwards.
 */
export async function repairToolRefs(): Promise<{ deleted: number; versions: string[] }> {
  const { rows } = await db.execute<{ skill_version_id: string }>(sql`
    delete from skill_structures s
     where s.extractor_version = ${EXTRACTOR_VERSION}
       and exists (
         select 1 from jsonb_each(s.tool_refs) t where jsonb_typeof(t.value) <> 'number'
       )
    returning s.skill_version_id
  `);
  return { deleted: rows.length, versions: rows.map((r) => r.skill_version_id) };
}

/**
 * How many skills in each function category carry a decision rule at all.
 *
 * Reads `block_counts`, which every fingerprint since 2.0.0 carries, at the **newest extractor
 * version that has rows** — and returns which version that was. Filtering on the current
 * version alone would report zero for every category the moment the version moved, and a
 * bumped version must not look like data loss (the taxonomy panel paid for that lesson).
 */
export async function decisionRuleCoverage() {
  const { rows: versions } = await db.execute<{ extractor_version: string; n: number }>(sql`
    select extractor_version, count(*)::int as n
      from skill_structures
     group by extractor_version
     order by string_to_array(extractor_version, '.')::int[] desc
  `);
  const current = versions.find((v) => v.extractor_version === EXTRACTOR_VERSION);
  const chosen = current && current.n > 0 ? current : versions.find((v) => v.n > 0);
  if (!chosen) return { extractorVersion: null, fallback: false, categories: [] as CategoryRules[] };

  const { rows } = await db.execute<CategoryRules>(sql`
    with current_labels as (
      select c.skill_id, c.value as category
        from skill_categories c
       where c.axis = 'function'
         and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
    )
    select l.category,
           count(distinct s.skill_id)::int as skills,
           count(distinct s.skill_id) filter (where coalesce((s.block_counts->>'decision-rule')::int, 0) > 0)::int as with_rules,
           coalesce(round(avg((s.block_counts->>'decision-rule')::int) filter (where (s.block_counts->>'decision-rule') is not null), 1), 0)::float as mean_rules
      from skill_structures s
      join skills sk on sk.id = s.skill_id and sk.current_version_id = s.skill_version_id
      join current_labels l on l.skill_id = s.skill_id
     where s.extractor_version = ${chosen.extractor_version}
       and sk.status = 'indexed' and sk.canonical_skill_id is null and sk.org_id is null
     group by l.category
     order by skills desc
  `);

  return {
    extractorVersion: chosen.extractor_version,
    fallback: chosen.extractor_version !== EXTRACTOR_VERSION,
    categories: rows,
  };
}

export type CategoryRules = {
  category: string;
  skills: number;
  with_rules: number;
  /** Mean decision-rule blocks among skills that have at least one. */
  mean_rules: number;
};
