import "server-only";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { CAPABILITY_META } from "@/lib/capabilities";
import { archetypeDetail, archetypeIndex } from "@/server/analytics/archetype-read";
import { getSkillBySlug, listSkills, PAGE_SIZES, SORTS } from "@/server/dal/skills";
import { platformStats } from "@/server/dal/stats";
import { exportSkill } from "@/server/skills/export";
import { DOMAIN_IDS, FUNCTION_IDS } from "@/server/taxonomy/vocabulary";
import { fence, UNTRUSTED_NOTICE } from "./untrusted";

/**
 * The free scope of R8.8, as MCP tools.
 *
 * ## Every tool is a thin wrapper, deliberately
 *
 * Each one calls the same `src/server/**` function the web pages call — `listSkills`,
 * `getSkillBySlug`, `archetypeDetail`, `exportSkill`. That is not laziness, it is the
 * requirement: R8.8 says an answer must not differ between the web app and MCP for the same
 * principal. Reimplementing a lighter read here would mean two definitions of "servable",
 * and the second one would drift — and the thing it would drift on is licence gating and
 * takedown enforcement, where drift is a legal problem rather than a bug.
 *
 * `exportSkill` is the clearest case. It refuses a withdrawn skill, an unlicensed one and a
 * metadata-only one *before reading any object*, and `download_skill` below gets all three
 * refusals for free by calling it and discarding the bytes.
 *
 * ## Structured input, because the caller is a machine
 *
 * The registry's own UI has one search box and one category control, because screen space is
 * finite and people self-correct after a bad result. An agent does neither: it fills a schema
 * perfectly and then acts on the top hit. So the search tool exposes the filters the sidebar
 * exposes plus the axis combination the sidebar has no room for, and every enum is the real
 * vocabulary rather than free text — an agent that guesses `"reviewing"` should get a schema
 * error, not zero results it will interpret as "the corpus has none".
 *
 * ## What is NOT here
 *
 * The paid scope (bulk lookup, verdict-by-content-hash, live archetype feed, org-scoped
 * corpora, anything that calls a model). It cannot be built before RC.1: there is no
 * entitlement to check, and checking one *here* rather than in the DAL is the single thing
 * R8.8 says must never happen.
 */

/** Corpus text reaches the caller fenced; JSON facts about it do not need to be. */
function result(payload: unknown, fenced: string[] = []) {
  return {
    content: [
      { type: "text" as const, text: UNTRUSTED_NOTICE },
      ...fenced.map((text) => ({ type: "text" as const, text })),
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

const CAPABILITY_KEYS = Object.keys(CAPABILITY_META) as [string, ...string[]];
const POSTURES = [
  "mirror_allowed",
  "attribution_required",
  "metadata_only",
  "unresolved",
] as const;

export function registerFreeTools(server: McpServer) {
  server.registerTool(
    "search_skills",
    {
      title: "Search the skill registry",
      description:
        "Find validated agent skills. Ranked by relevance when a query is given, otherwise " +
        "by quality. Only skills that passed validation are returned; near-duplicates are " +
        "folded under their canonical entry. Prefer the structured filters over packing " +
        "intent into `query`.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Free text. Matches name, summary and slug, tolerates typos."),
        function_category: z
          .enum(FUNCTION_IDS as [string, ...string[]])
          .optional()
          .describe("What the skill does. Archetypes are mined on this axis."),
        domain_category: z
          .enum(DOMAIN_IDS as [string, ...string[]])
          .optional()
          .describe("What field the skill serves."),
        capability: z
          .enum(CAPABILITY_KEYS)
          .optional()
          .describe("Only skills whose bundled code touches this capability."),
        licence_posture: z
          .enum(POSTURES)
          .optional()
          .describe("mirror_allowed and attribution_required can be downloaded; the others are metadata-only."),
        min_quality: z.number().int().min(0).max(100).optional(),
        sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).optional(),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().optional().describe(`One of ${PAGE_SIZES.join(", ")}.`),
      }),
    },
    async (args) => {
      const categories = [
        args.function_category ? `function:${args.function_category}` : null,
        args.domain_category ? `domain:${args.domain_category}` : null,
      ].filter((entry): entry is string => entry !== null);

      const page = await listSkills({
        query: args.query,
        categories,
        capability: args.capability,
        posture: args.licence_posture,
        minQuality: args.min_quality,
        sort: args.sort as never,
        page: args.page,
        pageSize: (PAGE_SIZES as readonly number[]).includes(args.page_size ?? 0)
          ? (args.page_size as never)
          : undefined,
      });

      return result(
        {
          total: page.total,
          page: page.page,
          page_count: page.pageCount,
          results: page.items.map((item) => ({
            slug: item.slug,
            name: item.name,
            summary: item.summary,
            quality_score: item.qualityScore,
            licence: { spdx: item.licenseSpdx, posture: item.redistribution },
            downloadable: item.contentStored,
            source: item.sourceName,
            categories: item.categories.map((c) => `${c.axis}:${c.value}`),
            near_duplicates: item.variantCount,
          })),
        },
        // Names and summaries are upstream text. They are short, so they are fenced as one
        // block rather than one fence per row — a page of results is a single quotation.
        page.items.length === 0
          ? []
          : [
              fence(
                page.items.map((i) => `${i.slug}: ${i.name} — ${i.summary ?? ""}`).join("\n"),
                { status: "indexed" },
              ),
            ],
      );
    },
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get one skill with its verdicts and provenance",
      description:
        "Everything the registry knows about one skill: where it came from, its licence, " +
        "every validation verdict with the analyzer version that produced it, and the " +
        "capability surface detected in its bundled code. This is what an install decision " +
        "should be made on.",
      inputSchema: z.object({ slug: z.string().min(1).max(200) }),
    },
    async ({ slug }) => {
      const skill = await getSkillBySlug(slug);
      if (!skill) return result({ found: false, slug });

      return result(
        {
          found: true,
          slug: skill.slug,
          name: skill.name,
          summary: skill.summary,
          dialect: skill.dialect,
          status: skill.status,
          quality_score: skill.qualityScore,
          licence: {
            spdx: skill.licenseSpdx,
            posture: skill.redistribution,
            resolved_by: skill.licenseSource,
          },
          provenance: {
            source: skill.sourceName,
            source_url: skill.sourceUrl,
            content_hash: skill.contentHash,
            file_count: skill.fileCount,
            synced_at: skill.syncedAt,
          },
          // The reason a caller should read this before running anything the skill ships.
          capabilities: {
            declared: skill.capabilities,
            undocumented: skill.undocumented,
            surface: skill.surface,
          },
          verdicts: skill.verdicts.map((verdict) => ({
            analyzer: verdict.analyzer,
            analyzer_version: verdict.analyzerVersion,
            result: verdict.result,
            severity: verdict.severity,
            findings: verdict.findings,
          })),
          categories: skill.categories.map((c) => `${c.axis}:${c.value}`),
          near_duplicates: skill.variantCount,
        },
        [
          fence([skill.name, skill.summary ?? ""].join("\n"), {
            slug: skill.slug,
            source: skill.sourceName,
            status: skill.status,
            qualityScore: skill.qualityScore,
          }),
        ],
      );
    },
  );

  server.registerTool(
    "download_skill",
    {
      title: "Get the download URL for a skill bundle",
      description:
        "Returns a URL for the validated bundle, or a refusal with its reason. A URL is " +
        "returned rather than bytes: the archive is a zip, and base64 in a tool result is a " +
        "poor way to move one. The bundle is bit-identical to what was validated and carries " +
        "its own receipt.",
      inputSchema: z.object({ slug: z.string().min(1).max(200) }),
    },
    async ({ slug }, ctx) => {
      /**
       * The licence and takedown gate is `exportSkill`'s, not ours.
       *
       * It refuses before reading any object, so calling it and throwing the bytes away is
       * cheaper than it looks and — far more importantly — means there is exactly one
       * implementation of "may this content be served". A second one here would be the
       * place a takedown eventually fails to apply.
       */
      const bundle = await exportSkill(slug);
      const origin = originOf(ctx);

      if (!bundle.ok) {
        return result({
          available: false,
          slug,
          // `withdrawn` and `not-licensed` are permanent; `not-indexed` and `not-stored`
          // may be resolved by a later version. An agent that cannot tell those apart will
          // either retry forever or give up on something that will work tomorrow.
          reason: bundle.reason,
          retryable: bundle.reason === "not-indexed" || bundle.reason === "not-stored",
          message: bundle.message,
        });
      }

      return result({
        available: true,
        slug,
        url: `${origin}/api/skills/${encodeURIComponent(slug)}/download`,
        filename: bundle.filename,
        content_hash: bundle.contentHash,
        validation_report_hash: bundle.reportHash,
        note: "Two downloads are byte-identical; the content hash is the one the verdicts cover.",
      });
    },
  );

  server.registerTool(
    "list_archetypes",
    {
      title: "List mined structural archetypes",
      description:
        "What a good skill in each function category actually looks like, derived from the " +
        "corpus rather than asserted. Categories below the evidence gate are listed too, " +
        "saying so — where the corpus is thin is itself useful to know.",
      inputSchema: z.object({}),
    },
    async () => {
      const entries = await archetypeIndex();
      return result({
        categories: entries.map((entry) => ({
          category: entry.category,
          label: entry.label,
          version: entry.version,
          mined: entry.version !== null,
          distinct_structures: entry.distinctStructures,
          source_count: entry.sourceCount,
          section_count: entry.sections.length,
          mined_at: entry.minedAt,
        })),
      });
    },
  );

  server.registerTool(
    "get_archetype",
    {
      title: "Get one category's archetype",
      description:
        "The mined section skeleton for a function category, each section carrying its lift " +
        "— prevalence among curated skills minus prevalence among the rest. Lift is the " +
        "finding: a section present in 90% of good skills AND 90% of weak ones is a fact " +
        "about markdown, not advice.",
      inputSchema: z.object({
        category: z.enum(FUNCTION_IDS as [string, ...string[]]),
      }),
    },
    async ({ category }) => {
      const detail = await archetypeDetail(category);
      if (!detail) {
        return result({
          found: false,
          category,
          reason: "below-evidence-gate",
          message: "Not enough distinct structures from enough sources to mine this category yet.",
        });
      }
      return result({
        found: true,
        category: detail.category,
        label: detail.label,
        version: detail.version,
        evidence: {
          skills: detail.skillCount,
          distinct_structures: detail.distinctStructures,
          sources: detail.sourceCount,
        },
        sections: detail.skeleton.sections,
        traits: detail.skeleton.traits,
        norms: detail.skeleton.norms,
        mined_at: detail.minedAt,
      });
    },
  );

  server.registerTool(
    "corpus_stats",
    {
      title: "Corpus size, freshness and licence mix",
      description:
        "How much is here, how much passed validation, how much can actually be downloaded, " +
        "and how stale it is. Ingestion is still running, so the skill count is the size so " +
        "far rather than the size.",
      inputSchema: z.object({}),
    },
    async () => {
      const stats = await platformStats();
      return result({
        indexed: stats.indexed,
        quarantined: stats.quarantined,
        pass_rate_percent: stats.passRate,
        downloadable: stats.downloadable,
        sources: { total: stats.sources, synced: stats.sourcesSynced },
        hours_since_last_sync: stats.hoursSinceSync,
        licence_mix: stats.licenceMix,
        archetypes: {
          categories_mined: stats.archetypeCategories,
          categories_total: stats.functionCategories,
          distinct_structures: stats.archetypeStructures,
        },
      });
    },
  );
}

/**
 * The public origin, taken from the request rather than from configuration.
 *
 * A download URL that names the wrong host is worse than no URL: the caller gets a
 * connection error and no reason for it. Falling back to the configured public URL keeps
 * this working when the header is absent.
 */
function originOf(ctx: unknown): string {
  const request = (ctx as { http?: { request?: Request } } | undefined)?.http?.request;
  if (request) {
    try {
      return new URL(request.url).origin;
    } catch {
      /* fall through */
    }
  }
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}
