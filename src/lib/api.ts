/**
 * The public JSON API (Doc 2 R8.6, R3.7, R8.3 — plan step F4).
 *
 * A leaf module with no imports: the routes, the reader, the FAQ and the verify suite all need
 * one vocabulary for what the API promises.
 *
 * ## Three requirements, one surface
 *
 * R8.6 wants bulk metadata access, R3.7 wants a research dataset, R8.3 wants hosted resolution.
 * The plan's own line says why they are not three projects — *"the metadata API is the read half
 * of what MCP already serves, over HTTP; the dataset export is the researcher offer Doc 1 makes;
 * resolution is version pinning over the content hash, in the shape a package runner expects."*
 * They are three **resource shapes** on one versioned surface, and every one of them calls the
 * same `src/server` function the web pages call.
 *
 * That last part is RM.2's rule, which was written for MCP and applies verbatim here: an answer
 * must not differ between surfaces, and the only honest way to guarantee it is to call the same
 * code. A lighter reimplementation would mean a second definition of "servable", and it would
 * drift on licence gating and takedowns — where drift is a legal problem rather than a bug.
 *
 * ## Metadata, never bodies, and that is what makes bulk access possible at all
 *
 * 96% of this corpus is `attribution_required` and some of it is `metadata_only`, which is the
 * posture meaning *"we may say it exists, name it, describe it and link to it — and may not hand
 * over the bytes"*. That is **exactly** the shape of a metadata API.
 *
 * So the API serves what we are permitted to serve for every skill in the corpus, including the
 * ones nobody may download, and it serves no body text at all. A bulk endpoint that included
 * bodies would be safe for none of the corpus; one that excludes them is safe for all of it. The
 * download route keeps its 451s and stays the only way to bytes.
 *
 * ## Two licences, and the response says which is which
 *
 * The **skills** are their authors', under whatever their repositories say — carried on every
 * record as `licence` and `redistribution`. The **derived analysis** is ours: verdicts, quality
 * scores, categories, archetypes, block statistics. Doc 1 licenses archetype snapshots CC BY-SA,
 * and the same terms are the honest offer for the rest of the derived data.
 *
 * Stating both on every payload is not legal decoration. A researcher who takes this dataset and
 * publishes a paper needs to know which half they may redistribute, and a single "licence" field
 * would be wrong for one of the two whichever value it held.
 */

export const API_VERSION = "v1";

/** What a consumer may do with each half of a response. Rendered into every envelope. */
export const API_LICENCE = {
  derived: {
    what: "Verdicts, quality scores, categories, archetypes and every other measurement here.",
    licence: "CC-BY-SA-4.0",
    attribution: "Skills Foundry",
  },
  skills: {
    what: "Names, descriptions and metadata belong to the skills' own authors.",
    licence: "See each record's `licence` and `redistribution` fields, and follow `origin`.",
  },
  bodies: {
    what: "Skill text is not served here, at any volume, under any licence.",
    where: "Download one at a time from /api/skills/{slug}/download, where the licence gate runs.",
  },
} as const;

/**
 * The page sizes the API offers — **the registry's own**, not a second set.
 *
 * The first version invented 10/25/50/100, which the DAL's narrow union rejected at compile time.
 * That refusal was right, and matching it is not a workaround: the API is the read half of the
 * registry, so the two paging behaviours are one behaviour. A wider list here would have been
 * silently clamped and the response would have reported a `pageSize` it had not used, which is
 * the class of confidently-wrong number this codebase keeps finding.
 *
 * Small pages are the right shape for browsing and the wrong shape for bulk, which is what the
 * dataset endpoint is for — it pages at `DATASET_PAGE` and streams a cursor. `verify:api` asserts
 * these two lists are equal so the copy cannot drift.
 */
export const API_PAGE_SIZES = [5, 10, 25] as const;
export const API_DEFAULT_PAGE_SIZE = 25;

export function apiPageSize(value: unknown): number {
  const n = Number(value);
  return (API_PAGE_SIZES as readonly number[]).includes(n) ? n : API_DEFAULT_PAGE_SIZE;
}

/**
 * How many records one dataset request streams.
 *
 * The dataset is the researcher offer and is meant to be taken whole, so this is large — but a
 * cursor rather than no bound at all, because a single request that walks 49,000 rows holds a
 * connection for the duration and the pool is ten.
 */
export const DATASET_PAGE = 1_000;

export const API_ERRORS = [
  "not-found",
  "rate-limited",
  "bad-request",
  "gone",
] as const;

export type ApiError = (typeof API_ERRORS)[number];

/**
 * A withdrawn skill is `gone`, not `not-found`, and the distinction is R8.4's.
 *
 * A permalink that silently 404s tells a reader nothing about whether the skill was dangerous,
 * deleted or withdrawn following a request. 410 says *it was here and it is not any more*, which
 * is a fact a citation can be resolved against — the same reasoning that keeps the withdrawn
 * skill's page alive with its grounds and date.
 */
export const API_ERROR_STATUS: Record<ApiError, number> = {
  "not-found": 404,
  "rate-limited": 429,
  "bad-request": 400,
  gone: 410,
};

/**
 * How long a public read may be cached.
 *
 * These are public facts about a corpus that changes twice a day, and the API exists so people
 * stop scraping pages — serving it uncached would replace one load with another. Short enough
 * that a takedown propagates within the hour, which is the one update that must not linger.
 */
export const API_CACHE_SECONDS = 300;
