/**
 * Demand signals (Doc 6 RK.5, Doc 2 R5.3, plan step E3).
 *
 * ## What the corpus does not contain is invisible to every other measurement here
 *
 * Archetypes describe what people wrote. Similarity describes what already exists. The quality
 * score, the verdicts, the trigger lab — all of them read the corpus. Not one can see the thing a
 * reader came for and did not find, and that is the most actionable signal a registry has: it is
 * the only one that says *build this*.
 *
 * So a search that returns nothing is logged, and a query enough distinct people asked becomes a
 * public most-wanted board. That also closes **R5.3's second half** — the similarity half (B3)
 * tells an author twelve near-identical skills exist, and this tells them nobody has written the
 * one being asked for.
 *
 * ## A search query is user-typed text, and the board is public
 *
 * That pair is the whole risk. "review our acme corp msa for renewal terms" is a demand signal
 * and also somebody's Monday morning, and publishing it because one person typed it would be a
 * leak dressed as a feature.
 *
 * Two defences, and neither is optional:
 *
 * - **No identity is stored.** Not an org, not a token, not an IP — a daily-rotating HMAC and
 *   nothing else, so "what did this customer search for" is a question the schema cannot answer.
 *   Same construction as `outcome_signals`, and unlinkability is a property of it rather than a
 *   promise about how we query.
 * - **A floor of distinct searchers before anything is publishable.** Below it a query describes
 *   the person who typed it. The same argument `MIN_DISTINCT_ORGS` makes for creation telemetry
 *   and `MIN_DISTINCT_SKILLS` makes for archetype outcomes: one mechanism serving R6.5 and
 *   privacy at once, and relaxing it for either breaks the other.
 */

/** Where the search came from. Both count; the split is for reading, not for weighting. */
export const SEARCH_CHANNELS = ["web", "mcp"] as const;

export type SearchChannel = (typeof SEARCH_CHANNELS)[number];

/**
 * Distinct searchers, on distinct days, before a query may appear on a public board.
 *
 * Higher than the telemetry floors because the unit is cheaper to manufacture: publishing a draft
 * takes work, and typing a search takes a second. Five separate people on five separate days is
 * not a person, and it is low enough that a real gap surfaces within a week.
 */
export const MIN_DISTINCT_SEARCHERS = 5;

/** Results at or below which a search counts as unmet. */
export const LOW_RESULT_THRESHOLD = 2;

/**
 * Shortest query worth recording.
 *
 * Below this it is a keystroke on the way to a real query — every prefix of every search anybody
 * types would otherwise be logged, and the board would be a list of two-letter fragments.
 */
export const MIN_QUERY_CHARS = 3;

/** Longest. Beyond it somebody pasted a document, which is not demand. */
export const MAX_QUERY_CHARS = 120;

/**
 * The stored form of a query.
 *
 * Normalised so that counting works at all: `Terraform Review`, `terraform review` and
 * `terraform  review ` are one demand signal and three rows without this. The raw text is
 * **never stored** — it adds nothing to a count and everything to a disclosure.
 *
 * Returns null for anything not worth a row, so the caller has one branch rather than four.
 */
export function normaliseQuery(raw: string): string | null {
  const text = raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'`]+|[\s"'`?.!,;:]+$/g, "")
    .trim();

  if (text.length < MIN_QUERY_CHARS) return null;
  if (text.length > MAX_QUERY_CHARS) return null;
  /*
   * A query that is all punctuation or digits is not demand. Cheap to exclude here and awkward
   * to explain on a public page later.
   */
  if (!/[a-z]{2}/.test(text)) return null;
  return text;
}

export type DemandRow = {
  query: string;
  /** Distinct searchers, floored — the number that decides publishability. */
  searchers: number;
  /** Times it was searched, across everybody. */
  searches: number;
  /** Median results those searches returned. 0 means nothing was found, ever. */
  medianResults: number;
  lastSearchedAt: Date;
};

/**
 * Whether a row may be shown publicly.
 *
 * Checked in the query that builds the board *and* here, deliberately. The SQL floor is what makes
 * the page safe; this is what makes a second caller — a CLI, a future API — safe by default rather
 * than by remembering. A single `HAVING` clause somebody edits is one keystroke from a leak.
 */
export function isPublishable(row: Pick<DemandRow, "searchers">): boolean {
  return row.searchers >= MIN_DISTINCT_SEARCHERS;
}

/** How a gap reads on the board. Unmet is the interesting case; thin is the second one. */
export function demandLabel(medianResults: number): "unmet" | "thin" {
  return medianResults === 0 ? "unmet" : "thin";
}
