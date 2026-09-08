import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * What people looked for (Doc 6 RK.5, Doc 2 R5.3, plan step E3).
 *
 * ## The only table here that deliberately cannot be attributed
 *
 * Every other org-scoped table carries an `org_id`, because knowing whose row it is makes it
 * safe. This one has none, and the absence is the safety property: a search query is user-typed
 * text — *"review our acme corp msa for renewal terms"* is a demand signal and also somebody's
 * Monday morning — and the board built from it is public.
 *
 * So **"what did this customer search for" is a question the schema cannot answer.** Not "does
 * not answer today"; cannot. There is no column to join, and adding one is the change to refuse.
 * If per-org demand is ever wanted for a Team surface it is a different table with a different
 * policy and a different conversation.
 *
 * ## The digest is for counting people, not for knowing them
 *
 * A daily-rotating HMAC of whatever identified the caller, truncated — the construction
 * `outcome_signals` already uses. It exists so that one person searching the same thing twelve
 * times counts once, and the day is inside the key so yesterday's digests cannot be recomputed
 * from today's salt. Unlinkability is a property of the construction rather than a promise about
 * how we query.
 *
 * ## Only the normalised query is stored
 *
 * `Terraform Review` and `terraform  review ` are one demand signal, and the raw text adds
 * nothing to a count and everything to a disclosure.
 */
export const searchQueries = pgTable(
  "search_queries",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Lower-cased, whitespace-collapsed, punctuation-trimmed. See `normaliseQuery`. */
    query: text("query").notNull(),
    /** How many skills came back. Zero is the signal; one or two is the weaker one. */
    resultCount: integer("result_count").notNull(),
    /** `web` or `mcp`. Recorded to read the two apart, never to weight them. */
    channel: text("channel").notNull(),

    day: date("day").notNull(),
    /**
     * A daily-rotating HMAC of the caller key. Never an IP, a token or an org.
     *
     * Counting rows **is** the deduplicated count: the unique index below means one searcher
     * asking the same thing twelve times in a day is one row, so there is no counter to drift and
     * no application logic a second call site could forget — the same property `outcome_signals`
     * gets from its index.
     */
    callerDigest: text("caller_digest").notNull(),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("search_queries_uq").on(t.query, t.channel, t.day, t.callerDigest),
    /** The board's query: group by text, count distinct digests, floor. */
    index("search_queries_demand_idx").on(t.query, t.resultCount),
    index("search_queries_at_idx").on(sql`${t.at} desc`),
    /*
     * Trigram, for R5.3's "people are asking for this" panel — a fuzzy match between an author's
     * purpose and what searchers typed. Without it that lookup is a sequential scan of every
     * query ever recorded, which is fine at a thousand rows and is not what this table will hold.
     *
     * `pg_trgm` is already installed: migration 0017 added it for the registry's typo tolerance,
     * and the same operator class serves both.
     */
    index("search_queries_trgm_idx").using("gin", sql`${t.query} gin_trgm_ops`),

    /**
     * Open to `app_runtime`, because there is no tenant to scope to — see the note above.
     *
     * That is safe **because of the column list**: a normalised query, a count, a channel, a day
     * and a digest. Nothing identifies anybody, and the public board applies the distinct-searcher
     * floor in SQL rather than relying on this policy for confidentiality. Add a column carrying
     * an identity and the policy becomes wrong.
     */
    pgPolicy("all_access", {
      for: "all",
      to: "app_runtime",
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);
