import "server-only";

import { sql } from "drizzle-orm";

import { API_LICENCE, API_VERSION, DATASET_PAGE } from "@/lib/api";
import { getAppUrl } from "@/lib/app-url";
import { db } from "@/server/db";
import type { SkillFilters } from "@/server/dal/skills";

/**
 * The DAL is imported lazily, and that is not a style choice.
 *
 * It reaches `next/navigation` to resolve a session, so a plain node process cannot load it —
 * `export.ts` was split into `buildBundle` and `exportSkill` for exactly this, and CLAUDE.md
 * records it. Importing it at module scope would make this whole file unloadable outside a
 * request, which would take `apiDataset` — pure SQL, and the endpoint where a body leak would be
 * worst — down with it and out of reach of any check.
 *
 * At runtime inside a route it resolves normally, and an anonymous request lands on exactly the
 * public corpus with RLS enforcing it.
 */
const dal = () => import("@/server/dal/skills");

/**
 * The public JSON API's reads (Doc 2 R8.6, R3.7, R8.3 — plan step F4).
 *
 * Every shape here calls the same `src/server` function a page calls. That is RM.2's rule, which
 * was written for MCP and holds identically over HTTP: an answer must not differ between
 * surfaces, and the only way to guarantee it is to call the same code. A lighter reimplementation
 * would be a second definition of *servable*, and the second would drift on licence gating and
 * takedowns — where drift is a legal problem rather than a bug.
 *
 * **No body text leaves this module, at any volume.** See `src/lib/api.ts`: metadata is exactly
 * what `metadata_only` permits, so a metadata API is serviceable for the whole corpus while a
 * bulk body export would be serviceable for none of it.
 */

/** The envelope every response carries. Two licences, because there are two. */
export function envelope<T>(data: T, extra: Record<string, unknown> = {}) {
  return {
    apiVersion: API_VERSION,
    licence: API_LICENCE,
    ...extra,
    data,
  };
}

export type ApiSkill = {
  slug: string;
  name: string;
  summary: string | null;
  dialect: string;
  qualityScore: number | null;
  licence: string | null;
  redistribution: string;
  downloadable: boolean;
  categories: Array<{ axis: string; value: string }>;
  source: string | null;
  variants: number;
  url: string;
};

/** R8.6's list. The registry's own query, its own filters, its own definition of servable. */
export async function apiListSkills(
  filters: SkillFilters,
): Promise<{ items: ApiSkill[]; total: number; page: number; pageSize: number }> {
  const { listSkills } = await dal();
  const page = await listSkills(filters);
  return {
    items: page.items.map(toApiSkill),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}

function toApiSkill(item: {
  slug: string;
  name: string;
  summary: string | null;
  dialect: string;
  qualityScore: number | null;
  licenseSpdx: string | null;
  redistribution: string;
  contentStored: boolean;
  sourceName: string | null;
  variantCount: number;
  categories: Array<{ axis: string; value: string }>;
}): ApiSkill {
  return {
    slug: item.slug,
    name: item.name,
    summary: item.summary,
    dialect: item.dialect,
    qualityScore: item.qualityScore,
    licence: item.licenseSpdx,
    redistribution: item.redistribution,
    /*
     * Stated rather than left to be inferred from the posture.
     *
     * A consumer deciding whether to attempt a download should not have to hold our licence
     * vocabulary in their head, and the two conditions that decide it — a permissive posture and
     * bytes we actually kept — are not obvious from either field alone.
     */
    downloadable:
      (item.redistribution === "mirror_allowed" || item.redistribution === "attribution_required") &&
      item.contentStored,
    categories: item.categories,
    source: item.sourceName,
    variants: item.variantCount,
    url: `${getAppUrl()}/skills/${item.slug}`,
  };
}

export type ApiSkillDetail = ApiSkill & {
  status: string;
  verdicts: Array<{ analyzer: string; version: string; result: string; findings: number }>;
  provenance: { sourceUrl: string | null; path: string | null; commit: string | null };
  contentHash: string | null;
  tokenEstimate: number | null;
  lifecycle: string | null;
};

export type SkillLookup =
  | { ok: true; skill: ApiSkillDetail }
  | { ok: false; error: "not-found" | "gone" };

/**
 * One skill, in full metadata.
 *
 * A withdrawn skill returns **410, not 404** — R8.4 wants citations to keep resolving, and *"it
 * was here and it is not any more"* is a fact a reader can act on where a silent 404 is not. The
 * same reasoning keeps the withdrawn skill's own page alive with its grounds and date.
 */
export async function apiGetSkill(slug: string): Promise<SkillLookup> {
  const { getSkillBySlug } = await dal();
  const skill = await getSkillBySlug(slug);
  if (!skill) return { ok: false, error: "not-found" };
  if (skill.status === "withdrawn") return { ok: false, error: "gone" };

  const provenance = (skill.provenance ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    skill: {
      ...toApiSkill({
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary,
        dialect: skill.dialect,
        qualityScore: skill.qualityScore,
        licenseSpdx: skill.licenseSpdx,
        redistribution: skill.redistribution,
        contentStored: skill.contentStored,
        sourceName: skill.sourceName,
        variantCount: 0,
        categories: skill.categories,
      }),
      status: skill.status,
      /*
       * The verdicts, which are the reason this API is worth consuming rather than scraping.
       *
       * A finding *count* per analyzer, not the findings themselves: the evidence can name a line
       * of somebody's skill, and a bulk-readable copy of "where the secret is" is a worse thing
       * to publish than the score it produced. The page shows them to a reader who came for one
       * skill; the API gives the shape of the answer.
       */
      verdicts: skill.verdicts.map((verdict) => ({
        analyzer: verdict.analyzer,
        version: verdict.analyzerVersion,
        result: verdict.result,
        findings: verdict.findings.length,
      })),
      provenance: {
        sourceUrl: (provenance.sourceUrl as string) ?? skill.sourceUrl ?? null,
        path: (provenance.path as string) ?? null,
        commit: (provenance.commitSha as string) ?? null,
      },
      contentHash: skill.contentHash,
      tokenEstimate: skill.tokenEstimate,
      lifecycle: skill.lifecycle,
    },
  };
}

export type Resolution =
  | {
      ok: true;
      slug: string;
      canonical: string;
      contentHash: string;
      downloadable: boolean;
      redistribution: string;
      licence: string | null;
      download: string | null;
      reason?: string;
    }
  | { ok: false; error: "not-found" | "gone" };

/**
 * R8.3 hosted resolution: a name in, a pinned version out.
 *
 * The shape a package runner expects, and the content hash is the point of it. Every other field
 * is decoration around *"this exact byte sequence is what you asked for"* — the same hash the
 * verdict covers and the storage key is derived from, so a consumer can check what they received
 * against what we said without trusting us.
 *
 * **A near-duplicate resolves to its canonical entry**, which is what makes this useful: an agent
 * asking for one of sixty copies of the same skill should get the one the registry actually
 * maintains, and be told the name it asked for was a variant.
 */
export async function apiResolve(slug: string): Promise<Resolution> {
  const { getSkillBySlug } = await dal();
  const skill = await getSkillBySlug(slug);
  if (!skill) return { ok: false, error: "not-found" };
  if (skill.status === "withdrawn") return { ok: false, error: "gone" };

  /*
   * `canonicalOf` is the parent a near-duplicate was clustered under, set by `analytics/dedupe`.
   * Absent on a canonical entry, which is the common case and resolves to itself.
   */
  const canonical = skill.canonicalOf?.slug ?? skill.slug;
  const downloadable =
    (skill.redistribution === "mirror_allowed" ||
      skill.redistribution === "attribution_required") &&
    skill.contentStored;

  return {
    ok: true,
    slug,
    canonical,
    contentHash: skill.contentHash ?? "",
    downloadable,
    redistribution: skill.redistribution,
    licence: skill.licenseSpdx,
    download: downloadable ? `${getAppUrl()}/api/skills/${canonical}/download` : null,
    /*
     * A refusal that says which refusal. "Not downloadable" covers a licence that forbids
     * copying, a licence we could not read, and a skill still in quarantine — three different
     * things to do next, and the download route already returns three different statuses.
     */
    reason: downloadable
      ? undefined
      : skill.redistribution === "metadata_only"
        ? "The licence permits us to describe this skill and not to serve it. Follow `origin`."
        : skill.redistribution === "unresolved"
          ? "We could not determine a licence, so no copy was kept. Follow `origin`."
          : "No stored copy.",
  };
}

/**
 * R3.7's dataset: the derived analysis, streamed, metadata only.
 *
 * Cursor-paged rather than unbounded. A single request walking 49,000 rows holds a connection for
 * its whole duration and the pool is ten — the same arithmetic that caps `bundleConcurrency` at
 * six. The cursor is the slug, which is unique and ordered, so a resumed export cannot skip or
 * repeat a row the way an offset can when the corpus grows underneath it.
 */
export async function apiDataset(after: string | null, limit = DATASET_PAGE) {
  const { rows } = await db.execute<{
    slug: string;
    name: string;
    summary: string | null;
    dialect: string;
    quality_score: number | null;
    license_spdx: string | null;
    redistribution: string;
    categories: string[] | null;
    source: string | null;
    content_hash: string | null;
    token_estimate: number | null;
  }>(sql`
    select s.slug, s.name, s.summary, s.dialect, s.quality_score,
           v.license_spdx, v.redistribution, s.categories,
           src.name as source, v.content_hash, st.token_estimate
      from skills s
      join skill_versions v on v.id = s.current_version_id
      left join sources src on src.id = v.source_id
      left join skill_structures st
        on st.skill_version_id = v.id and st.token_estimate is not null
     where s.status = 'indexed'
       and s.org_id is null
       and s.canonical_skill_id is null
       ${after ? sql`and s.slug > ${after}` : sql``}
     order by s.slug asc
     limit ${Math.min(limit, DATASET_PAGE)}
  `);

  return {
    records: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      dialect: row.dialect,
      qualityScore: row.quality_score,
      licence: row.license_spdx,
      redistribution: row.redistribution,
      categories: row.categories ?? [],
      source: row.source,
      contentHash: row.content_hash,
      tokenEstimate: row.token_estimate,
    })),
    /** Null when the page came back short, which is how a consumer knows it is finished. */
    nextCursor: rows.length === Math.min(limit, DATASET_PAGE) ? rows[rows.length - 1].slug : null,
  };
}
