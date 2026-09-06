import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { BLOCK_TYPES, type BlockType } from "@/lib/block-types";
import { ingestPolicy } from "@/server/crawl/policy";
import { db } from "@/server/db";
import { skillBlocks, skills, skillStructures, skillVersions } from "@/server/db/schema";
import { mapWithConcurrency } from "@/server/lib/concurrency";
import { splitFrontmatter } from "@/server/skills/normalize";
import { REVIEW_FLOOR } from "@/server/taxonomy/vocabulary";
import { loadBundle, type VersionProvenance } from "@/server/validation/bundle-loader";

import { extractBlocks, type BlockRule } from "./blocks";
import { EXTRACTOR_VERSION, extractStructure } from "./structure";

/**
 * Block reporting: a dry run over real bundles, and the stored-row summary.
 *
 * ## Why the dry run exists at all
 *
 * A rule table is easy to verify weakly. `verify:blocks` proves each rule *can* fire on a
 * fixture written to make it fire, which is necessary and nowhere near sufficient — it
 * cannot tell you that one rule swallows 80% of the corpus, or that `anti-example` never
 * fires on real text, and both of those would make the taxonomy worthless while every
 * check stayed green. That is the same failure this codebase has already paid for twice: a
 * grep that could not see the call sites it guarded, and a unique-violation handler that
 * matched nothing.
 *
 * So `probeBlocks` runs the real detector over real bundles and **writes nothing**. It is
 * the dry run for a rule change: change a cue, probe 300 skills, read the distribution,
 * and only then spend a re-extract. It is also what answers Doc 6 §7's open question — the
 * taxonomy earns its keep or gets pruned — with a number instead of an opinion.
 *
 * Its selection query deliberately does **not** have to agree with the extractor's. This is
 * a sampler, not a gate: the two answer different questions, so the usual rule about
 * duplicated queries drifting apart does not bite here.
 */

export type BlockProbeReport = {
  versions: number;
  failed: number;
  blocks: number;
  classified: number;
  /** Blocks per type, and `unclassified`. */
  byType: Record<string, number>;
  /** Which rule fired, so a rule that swallows the corpus is visible by name. */
  byRule: Record<string, number>;
  /** How many of the sampled skills carry at least one block of the type. */
  skillsWithType: Record<string, number>;
  /** Where the unclassified mass sits: `parentRole/kind`, most common first. */
  unclassifiedShape: Array<{ shape: string; count: number }>;
  /** Short snippets, for tuning. Local diagnostic only, never stored. */
  samples: string[];
};

export type BlockProbeOptions = {
  limit?: number;
  /** Restrict to one function category, to see whether a type is category-specific. */
  category?: string;
  /** Collect up to this many snippets. Off by default. */
  sampleCount?: number;
  /**
   * Which type to sample: a block type, or `unclassified`.
   *
   * Sampling a *classified* type is the check that matters most and is easiest to skip. A
   * distribution cannot tell you a rule is firing on the wrong passages — only reading a
   * dozen of them can, and `anti-example` in particular sits behind cues (`wrong`,
   * `incorrect`) that ordinary prose uses too.
   */
  sampleType?: string;
};

export async function probeBlocks(options: BlockProbeOptions = {}): Promise<BlockProbeReport> {
  const limit = options.limit ?? 200;
  const sampleCount = options.sampleCount ?? 0;

  const rows = options.category
    ? ((
        await db.execute(sql`
          select sv.id, sv.org_id, sv.content_hash, sv.content_stored, sv.provenance
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
        contentHash: r.content_hash as string,
        contentStored: Boolean(r.content_stored),
        provenance: r.provenance as VersionProvenance,
      }))
    : await db
        .select({
          id: skillVersions.id,
          contentHash: skillVersions.contentHash,
          contentStored: skillVersions.contentStored,
          provenance: skillVersions.provenance,
        })
        .from(skillVersions)
        .innerJoin(skills, eq(skills.id, skillVersions.skillId))
        .where(and(eq(skills.status, "indexed"), inArray(skillVersions.status, ["indexed"])))
        .orderBy(sql`random()`)
        .limit(limit);

  const report: BlockProbeReport = {
    versions: 0,
    failed: 0,
    blocks: 0,
    classified: 0,
    byType: {},
    byRule: {},
    skillsWithType: {},
    unclassifiedShape: [],
    samples: [],
  };
  const shapes = new Map<string, number>();

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
      const blocks = extractBlocks({
        body,
        headings: fingerprint.headings,
        bundlePaths: new Set(files.map((f) => f.path.replace(/^\.\//, ""))),
      });

      report.versions += 1;
      report.blocks += blocks.length;

      const seen = new Set<string>();
      for (const block of blocks) {
        const key = block.type ?? "unclassified";
        report.byType[key] = (report.byType[key] ?? 0) + 1;
        if (block.type) {
          report.classified += 1;
          report.byRule[block.rule as BlockRule] = (report.byRule[block.rule as BlockRule] ?? 0) + 1;
        } else {
          /**
           * Three states, not two, and conflating them cost an hour.
           *
           * `parentRole` is null both above the first heading *and* under a heading the
           * role rules did not recognise — a topical one like "Typography", which is the
           * correct outcome there and is most of the corpus's headings. Labelling both
           * "(preamble)" reported 2,360 blocks sitting above the first heading, which is
           * impossible, and sent me looking for an attribution bug that did not exist. The
           * number disagreed with what it claimed to measure, which is the failure mode
           * this codebase keeps paying for.
           */
          const section =
            block.parentHeadingOrder === null
              ? "(preamble)"
              : (block.parentRole ?? "(unroled heading)");
          const shape = `${section}/${block.features.kind}`;
          shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
        }
        if (report.samples.length < sampleCount && (options.sampleType ?? "unclassified") === key) {
          report.samples.push(
            `${block.rule ?? "—"} · ${body
              .slice(block.startChar, Math.min(block.endChar, block.startChar + 110))
              .replace(/\s+/g, " ")}`,
          );
        }
        if (!seen.has(key)) {
          seen.add(key);
          report.skillsWithType[key] = (report.skillsWithType[key] ?? 0) + 1;
        }
      }
    } catch {
      // Counted, not thrown — same posture as the extractor: a missing fingerprint is a
      // coverage problem, and this one does not even write.
      report.failed += 1;
    }
  });

  report.unclassifiedShape = [...shapes.entries()]
    .map(([shape, count]) => ({ shape, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return report;
}

/** Coverage of the stored table, for the CLI and the settings panel. */
export async function blockSummary() {
  const [totals] = await db
    .select({
      versions: sql<number>`count(distinct ${skillStructures.skillVersionId})::int`,
      withBlocks: sql<number>`count(*) filter (where ${skillStructures.blockCount} > 0)::int`,
      /**
       * Skills carrying at least one *classified* block, which is not the same number.
       * `block_types` holds only recognised types, so a document that segmented cleanly and
       * matched no rule counts in `withBlocks` and not here — and the gap between the two is
       * the honest read on how much of the corpus the vocabulary actually recognises.
       */
      withClassified: sql<number>`count(*) filter (where ${skillStructures.blockTypes} <> '{}')::int`,
      avgBlocks: sql<number>`coalesce(round(avg(${skillStructures.blockCount}))::int, 0)`,
      avgTokens: sql<number>`coalesce(round(avg(${skillStructures.tokenEstimate}))::int, 0)`,
    })
    .from(skillStructures)
    .where(eq(skillStructures.extractorVersion, EXTRACTOR_VERSION));

  const byType = await db
    .select({ type: sql<string>`t`, skills: sql<number>`count(*)::int` })
    .from(
      sql`(select unnest(${skillStructures.blockTypes}) as t
           from ${skillStructures}
           where ${skillStructures.extractorVersion} = ${EXTRACTOR_VERSION}) types`,
    )
    .groupBy(sql`t`)
    .orderBy(sql`count(*) desc`);

  /** Rule-level counts, so a rule that swallows the corpus is visible by name. */
  const byRule = await db
    .select({ rule: sql<string>`rule`, blocks: sql<number>`count(*)::int` })
    .from(skillBlocks)
    .where(and(eq(skillBlocks.extractorVersion, EXTRACTOR_VERSION), sql`${skillBlocks.rule} is not null`))
    .groupBy(sql`rule`)
    .orderBy(sql`count(*) desc`);

  const [blockTotals] = await db
    .select({
      blocks: sql<number>`count(*)::int`,
      classified: sql<number>`count(*) filter (where ${skillBlocks.type} is not null)::int`,
    })
    .from(skillBlocks)
    .where(eq(skillBlocks.extractorVersion, EXTRACTOR_VERSION));

  return { totals, blockTotals, byType, byRule, vocabulary: BLOCK_TYPES as readonly BlockType[] };
}
