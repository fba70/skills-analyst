import "server-only";

import { sql } from "drizzle-orm";

import { isBlockType, type BlockType } from "@/lib/block-types";
import { CURATED_LIST } from "@/server/analytics/archetype";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { db } from "@/server/db";
import { mapWithConcurrency } from "@/server/lib/concurrency";
import { ingestPolicy } from "@/server/crawl/policy";
import { splitFrontmatter } from "@/server/skills/normalize";
import { getBundleFile } from "@/server/storage";
import { REVIEW_FLOOR } from "@/server/taxonomy/vocabulary";

/**
 * The block library (Doc 6 RW.3) — real fragments an author can read before writing.
 *
 * The archetype says *a curated review skill carries a decision rule, 75% against 55%*. An
 * author's next question is immediate and the platform could not answer it: **what does a
 * good one look like?** Eight exemplar skills is the current answer, and it asks somebody to
 * open eight documents and find the relevant passage in each. The blocks table already knows
 * where every passage is.
 *
 * ## A row is a coordinate, so a fragment is resolved and never stored
 *
 * `skill_blocks` holds `[startChar, endChar)` into the marker body and no text — deliberately,
 * and this module is the reason. Text is read live from the content-addressed bundle at
 * request time, which gives three properties a stored copy could not:
 *
 *   - **the licence gate applies at the moment of reading**, not at the moment of extraction,
 *     so it is the same gate the download route enforces rather than a snapshot of what it
 *     said months ago;
 *   - **a withdrawn skill stops being quotable immediately** (R7.5). A stored fragment would
 *     go on being offered as good practice after a takedown, which is precisely the failure
 *     the takedown design spends its whole file avoiding;
 *   - **an edited skill cannot be misquoted.** The offsets belong to one `content_hash`; if
 *     upstream changed, that version is superseded and its blocks are re-extracted.
 *
 * ## Ranked on source trust, never on the quality score alone
 *
 * This is the same reversal the miner had to make, and for the same reason. `quality_score`
 * is bounded at 100 with thousands of skills tied there, and every multi-file bundle collects
 * an `orphaned-resources` note — so ranking fragments by it would surface single-file skills
 * with no code examples and call them exemplary. **The band is the curated allow-list**, the
 * identical `CURATED_LIST` the archetype is mined from, imported rather than copied: the
 * library shows fragments from the same band that produced the guidance, or the guidance and
 * its examples are two different claims.
 *
 * Popularity gets no vote, exactly as in R2.9's search ranking and in the archetype bands.
 *
 * ## What it refuses to show, and why each refusal is load-bearing
 *
 * - **Unlicensed content.** `metadata_only` and `unresolved` skills are analysed and never
 *   copied, so their blocks are *counted* by the miner and never *quoted* here. The row still
 *   exists — which is the point of storing a coordinate — and the reader gets attribution and
 *   a link to origin instead of the text.
 * - **More than one fragment per skill.** A skill with nine guardrails would otherwise fill
 *   the list, which is the "one generator's 300 clones are one data point" argument at
 *   fragment scale.
 * - **Near-duplicate variants.** `canonical_skill_id is not null` is excluded, or the library
 *   returns the same paragraph from sixty repositories.
 * - **Fragments too short or too long to be exemplary.** A four-word guardrail teaches
 *   nothing and a 400-word one is a section wearing a block's clothes.
 *
 * ## Every fragment is untrusted text
 *
 * A fragment is prose written by a stranger, and the compose step puts it in front of an
 * author and can put it into a model's context. That is R7.3 exactly, so text that reaches a
 * prompt goes through the same fence the MCP tools use — see `fencedFragments`.
 */

/**
 * Bounds on what can be held up as an example, in words.
 *
 * Not a quality judgement, a usefulness one: below the floor there is nothing to learn from,
 * and above the ceiling the "fragment" is really a section and would dominate the panel it
 * appears in. Both are applied in SQL so they cost nothing.
 */
export const FRAGMENT_MIN_WORDS = 12;
export const FRAGMENT_MAX_WORDS = 220;

/** How many fragments a caller may ask for at once. A library is browsed, not bulk-read. */
export const MAX_FRAGMENTS = 12;

export type FragmentAttribution = {
  slug: string;
  name: string;
  /** Repository name as GitHub reports it, casing intact — what an attribution must show. */
  source: string;
  sourceUrl: string | null;
  licenseSpdx: string | null;
  redistribution: string;
  qualityScore: number | null;
  /** True when the skill is in the band the archetype was mined from. */
  curated: boolean;
};

export type Fragment = {
  id: string;
  type: BlockType;
  /** Which detector rule typed it — so a surprising fragment can be traced to a rule. */
  rule: string | null;
  kind: string;
  wordCount: number;
  tokenEstimate: number;
  /** The section role the fragment sits under, or null above the first heading. */
  parentRole: string | null;
  attribution: FragmentAttribution;
  /**
   * The passage, or null when the licence does not permit copying it.
   *
   * Two different nulls, distinguished by `withheld`: not permitted, or permitted and the
   * bundle could not be read. A reader must be able to tell "we may not show you this" from
   * "something went wrong", because only the first is a fact about the skill.
   */
  text: string | null;
  withheld: "licence" | "unavailable" | null;
};

export type LibraryQuery = {
  category: string;
  type: BlockType;
  limit?: number;
  /**
   * Include fragments from outside the curated band, ranked below it.
   *
   * Off by default. On for a thin category, where "no examples" is a worse answer than
   * "examples from the wider corpus, labelled as such" — and the label is `curated` on every
   * row, so a caller can never present the two as equivalent by accident.
   */
  includeWiderCorpus?: boolean;
};

export type LibraryResult = {
  fragments: Fragment[];
  /** Candidates the band held before the licence gate ran — the honest denominator. */
  candidates: number;
  /** How many were withheld for licence reasons, so a short list explains itself. */
  withheldForLicence: number;
  /** True when the curated band alone produced nothing and the wider corpus was not asked. */
  bandEmpty: boolean;
};

/**
 * Postures whose bytes may be copied — the download route's `EXPORTABLE`, restated.
 *
 * Restated rather than imported because `export.ts` holds it as a private `Set` and the
 * honest options were to export that or to write it twice. It is written twice and
 * `verify:blocks` asserts the two agree, because the alternative is a library that quotes a
 * skill the download route refuses — a licence divergence, which is a legal problem rather
 * than a bug.
 */
const QUOTABLE = ["mirror_allowed", "attribution_required"] as const;

/** The same set as a runtime array, for the licence check in node. */
const QUOTABLE_LIST: string[] = [...QUOTABLE];

/**
 * And the same set as one comma-joined string, split in SQL.
 *
 * Not a bound JS array, which is the trap `CURATED_LIST` documents two files away and which
 * this query hit anyway: Drizzle renders a JS array in a `sql` template as a **row
 * constructor** — `($1, $2)` — so `= any(...)` fails with *op ANY/ALL (array) requires array
 * on right side*. Postures are single words from an enum, so the join is lossless.
 */
const QUOTABLE_SQL: string = QUOTABLE.join(",");

/**
 * Candidate fragments for one category and block type, best first, text resolved.
 *
 * One query then a bounded set of object reads. The query does the ranking and the
 * one-per-skill reduction in SQL — `distinct on (skill_id)` — because doing it in node means
 * fetching every guardrail in the category to throw nearly all of them away, which is how
 * `/skills` came to take 2.3 seconds.
 */
export async function libraryFragments(query: LibraryQuery): Promise<LibraryResult> {
  const limit = Math.min(Math.max(1, query.limit ?? 6), MAX_FRAGMENTS);
  if (!isBlockType(query.type)) {
    return { fragments: [], candidates: 0, withheldForLicence: 0, bandEmpty: true };
  }

  const rows = await candidateRows(query.category, query.type, limit, false);
  const wider =
    rows.length === 0 && query.includeWiderCorpus
      ? await candidateRows(query.category, query.type, limit, true)
      : [];
  const chosen = rows.length > 0 ? rows : wider;

  /*
   * Resolved concurrently, because the cost is entirely the object read.
   *
   * Six lanes, the same `bundleConcurrency` the derived stages use, and for the same reason
   * the note there gives: the pool is capped at ten and the remaining four keep the queries
   * that decide what to do next from queueing behind the batch.
   */
  const fragments = await mapWithConcurrency(
    chosen,
    ingestPolicy.bundleConcurrency,
    async (row): Promise<Fragment> => {
      const attribution: FragmentAttribution = {
        slug: row.slug,
        name: row.name,
        source: row.source,
        sourceUrl: row.source_url,
        licenseSpdx: row.license_spdx,
        redistribution: row.redistribution,
        qualityScore: row.quality_score,
        curated: row.curated,
      };
      const base = {
        id: row.id,
        type: query.type,
        rule: row.rule,
        kind: row.kind,
        wordCount: row.word_count,
        tokenEstimate: row.token_estimate,
        parentRole: row.parent_role,
        attribution,
      };

      /*
       * The licence check is here rather than in the query on purpose.
       *
       * Filtering unquotable skills out in SQL would produce a shorter list with no
       * explanation, and "there are no good guardrails in this category" and "there are four
       * and we may not show them to you" are opposite conclusions from an identical panel.
       * So the row survives, carrying attribution and a link, and says which it is.
       */
      if (!QUOTABLE_LIST.includes(row.redistribution) || !row.content_stored) {
        return { ...base, text: null, withheld: "licence" };
      }

      const text = await readFragment(row.content_hash, row.marker_path, row.start_char, row.end_char);
      return text === null
        ? { ...base, text: null, withheld: "unavailable" }
        : { ...base, text, withheld: null };
    },
  );

  return {
    fragments,
    candidates: chosen.length,
    withheldForLicence: fragments.filter((f) => f.withheld === "licence").length,
    bandEmpty: rows.length === 0,
  };
}

type CandidateRow = {
  id: string;
  skill_id: string;
  source_id: string;
  quotable: boolean;
  slug: string;
  name: string;
  source: string;
  source_url: string | null;
  license_spdx: string | null;
  redistribution: string;
  quality_score: number | null;
  curated: boolean;
  content_hash: string;
  content_stored: boolean;
  marker_path: string | null;
  start_char: number;
  end_char: number;
  rule: string | null;
  kind: string;
  word_count: number;
  token_estimate: number;
  parent_role: string | null;
};

/**
 * The ranking query — and every clause in the ORDER BY is here because the first version
 * ranked badly in a way only reading the output could show.
 *
 * That first version sorted the curated band by `quality_score desc, word_count desc`, ran
 * against the live corpus, and produced three defects at once. All three are the same
 * mistake in different costumes: a sort key that looked like a quality signal and was not.
 *
 * **1. Quality score is degenerate here, so it was not sorting anything.** Every fragment
 * came back `q100` — which is exactly what `archetype.ts` documents at length about the
 * score being bounded at 100 with thousands of skills tied there. The tiebreaker was
 * therefore doing all the work, silently.
 *
 * **2. So `word_count desc` decided, and it means "longest under the ceiling".** The results
 * were 219, 216, 200 and 199 words against a 220-word cap — the library was reliably
 * returning the biggest passage that fit rather than a representative one. Ranking is now on
 * **distance from the median length of this type in this band**, computed in the same query.
 * The typical good fragment is what an author should be shown; the longest one is an artifact
 * of where the ceiling was put.
 *
 * **3. Unquotable fragments crowded out readable ones.** Reference pointers came back with
 * three of four withheld, all from one repository whose licence is `unresolved` — a panel of
 * four items with one usable. A withheld fragment is still worth listing, because attribution
 * plus a link to origin is a real answer, but it belongs *below* anything the reader can
 * actually read. So quotability sorts first.
 *
 * `distinct on (src.id)` is the other half of that fix: **one fragment per source**, not per
 * skill. One vendor supplying three of four entries is the "one generator's 300 clones are
 * one data point" argument at fragment scale, and it is why R3.4 credits attribution in
 * distinct structures rather than in skills.
 */
async function candidateRows(
  category: string,
  type: BlockType,
  limit: number,
  includeWiderCorpus: boolean,
): Promise<CandidateRow[]> {
  const result = await db.execute(sql`
    with eligible as (
      select
        b.id::text as id,
        sk.id as skill_id, sk.slug, sk.name, sk.quality_score,
        src.id as source_id, src.name as source, src.url as source_url,
        sv.license_spdx, sv.redistribution::text as redistribution,
        sv.content_hash, sv.content_stored,
        st.marker_path,
        b.start_char, b.end_char, b.rule, b.kind, b.word_count, b.token_estimate,
        b.parent_role,
        (lower(src.name) = any(string_to_array(${CURATED_LIST}, ','))) as curated,
        (sv.redistribution::text = any(string_to_array(${QUOTABLE_SQL}, ','))
          and sv.content_stored) as quotable
      from skill_blocks b
      join skill_versions sv on sv.id = b.skill_version_id
      join skills sk on sk.id = b.skill_id
      join sources src on src.id = sv.source_id
      join skill_structures st on st.skill_version_id = sv.id
        and st.extractor_version = ${EXTRACTOR_VERSION}
      join skill_categories c on c.skill_id = sk.id
      where b.extractor_version = ${EXTRACTOR_VERSION}
        and b.type = ${type}
        and b.org_id is null
        and c.axis = 'function'
        and c.value = ${category}
        and (c.confidence >= ${REVIEW_FLOOR} or c.reviewed_at is not null)
        and sk.status = 'indexed'
        and sk.canonical_skill_id is null
        and sv.id = sk.current_version_id
        and st.marker_path is not null
        and b.word_count between ${FRAGMENT_MIN_WORDS} and ${FRAGMENT_MAX_WORDS}
    ),
    /*
     * The typical length, over the band actually being ranked.
     *
     * Computed per query rather than hard-coded, because a typical guardrail and a typical
     * procedure are different lengths and a single constant would flatter one type and
     * penalise the other. Falls back to the midpoint of the bounds when the band is too thin
     * for a median to mean anything.
     */
    target as (
      select coalesce(
        percentile_cont(0.5) within group (order by word_count)
          filter (where ${includeWiderCorpus ? sql`true` : sql`curated`}),
        ${(FRAGMENT_MIN_WORDS + FRAGMENT_MAX_WORDS) / 2}
      ) as words
      from eligible
    ),
    -- One per source. See the JSDoc above.
    per_source as (
      select distinct on (e.source_id) e.*
      from eligible e, target t
      ${includeWiderCorpus ? sql`` : sql`where e.curated`}
      order by e.source_id,
               e.quotable desc,
               abs(e.word_count - t.words) asc,
               e.quality_score desc nulls last,
               e.id
    )
    select p.* from per_source p, target t
    order by p.quotable desc,
             p.curated desc,
             abs(p.word_count - t.words) asc,
             p.quality_score desc nulls last,
             p.id
    limit ${limit}
  `);
  return result.rows as unknown as CandidateRow[];
}

/**
 * One passage, sliced out of the marker body.
 *
 * **Character offsets, not bytes**, which is why the buffer is decoded before slicing. The
 * extractor counted characters over a decoded string, so slicing the raw buffer would tear
 * multi-byte text apart — and a corpus this size is full of arrows, emoji and box drawing.
 *
 * Returns null rather than throwing on a missing object. A fragment that cannot be read is
 * an availability problem and must not take out the panel around it; the caller renders it
 * as `unavailable`, which is the honest label.
 *
 * **Exported for the scope analyser (RW.10, plan step C5), and that is the point.** It also
 * needs a block's text from its offsets, and a second copy of this function would be a second
 * source of truth for where a body starts — the exact bug the paragraph above records. One
 * definition, two callers.
 */
export async function readFragment(
  contentHash: string,
  markerPath: string | null,
  startChar: number,
  endChar: number,
): Promise<string | null> {
  const body = await readMarkerBody(contentHash, markerPath);
  if (body === null) return null;
  const text = body.slice(startChar, endChar).trim();
  return text.length > 0 ? text : null;
}

/**
 * The marker file's body, with frontmatter split off — the base every offset indexes into.
 *
 * Separated from `readFragment` because the scope analyser (RW.10, plan step C5) needs **every**
 * block of one document, and calling the fragment reader per block would fetch the same object
 * from an EU bucket thirty-six times. That is not a hypothetical inefficiency: it is the exact
 * shape of the bug `concurrency.ts` exists to record, where the derived stages pulled each
 * bundle back one at a time and a pass took fifty minutes instead of ten.
 *
 * One fetch, one split, N slices — and still exactly one definition of where a body starts.
 */
export async function readMarkerBody(
  contentHash: string,
  markerPath: string | null,
): Promise<string | null> {
  if (!markerPath) return null;
  try {
    const buffer = await getBundleFile("public", contentHash, markerPath);
    if (!buffer) return null;
    /*
     * `splitFrontmatter`, not a local reimplementation — and the first draft of this file got
     * that wrong.
     *
     * The offsets index the body the extractor segmented, which is
     * `splitFrontmatter(raw).body`. Reading them against the whole file returns a passage
     * shifted by the length of the YAML block: text that looks plausible and is the wrong
     * text, attributed to a named repository. That is worse than showing nothing.
     *
     * Writing a three-line frontmatter stripper here would have been a **second source of
     * truth for an offset base**, which is the same mistake as a checker holding its own copy
     * of the rule it checks. It also would have been subtly wrong — the real function matches
     * a regex with its own newline handling, and it never throws, returning any YAML error
     * as a field instead. There is exactly one definition of where a body starts.
     */
    return splitFrontmatter(buffer.toString("utf8")).body;
  } catch {
    return null;
  }
}
