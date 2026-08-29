import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { sources } from "./corpus";
import { crawlShardStatus, discoveredRepoStatus } from "./enums";

/**
 * The open crawl (Doc 2 R1.1, Doc 4 §4).
 *
 * GitHub code search caps every query at 1,000 results and allows ~10 requests a minute,
 * while `filename:SKILL.md` alone reports over 300,000 hits. So the corpus is only
 * reachable by partitioning the query space into shards small enough to fit under the
 * cap, and the crawl then takes days rather than minutes.
 *
 * That length is why this is a *ledger* and not a loop. Every shard records what it was
 * asked, how far it got and whether it saturated, so a crawl survives a deploy, a
 * rate-limit pause, or a crash, and — the part that actually matters — so we can say
 * which parts of the search space have genuinely been covered. A crawl that cannot answer
 * that produces a corpus that looks complete and is not.
 */
export const crawlShards = pgTable(
  "crawl_shards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    /** The literal query sent to GitHub, e.g. `filename:SKILL.md size:0..500`. */
    query: text("query").notNull(),
    /** The partition this shard covers, e.g. `{ "sizeMin": 0, "sizeMax": 500 }`. */
    bounds: jsonb("bounds").notNull().default(sql`'{}'::jsonb`),
    /** Set when a saturated shard was split; the children cover the parent's range. */
    parentId: uuid("parent_id"),

    status: crawlShardStatus("status").notNull().default("pending"),
    /** What GitHub reported as the total. Above 1,000 the shard cannot be fully read. */
    reportedTotal: integer("reported_total"),
    /** Result pages consumed so far — the resume point. */
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /** Distinct files actually seen. Compare with `reportedTotal` to judge coverage. */
    itemsSeen: integer("items_seen").notNull().default(0),
    reposFound: integer("repos_found").notNull().default(0),

    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("crawl_shards_query_uq").on(t.query),
    index("crawl_shards_status_idx").on(t.status, t.createdAt),
    index("crawl_shards_parent_idx").on(t.parentId),
  ],
);

/**
 * Repositories the crawl found, before anything is fetched from them.
 *
 * A staging table rather than writing straight into `sources`: discovery turns up tens of
 * thousands of repos, most of them forks, and syncing each costs API budget. Keeping the
 * raw finding separate means the decision to sync is explicit, reversible, and auditable —
 * and a skipped repo keeps its reason instead of vanishing.
 */
export const discoveredRepos = pgTable(
  "discovered_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    host: text("host").notNull().default("github.com"),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    url: text("url").notNull(),

    /**
     * Forks are the single largest duplicate class in the open crawl (Doc 2 R1.4), so
     * they are filtered at discovery rather than deduplicated after fetching.
     */
    isFork: boolean("is_fork"),
    parentRepo: text("parent_repo"),
    stars: integer("stars"),
    archived: boolean("archived"),
    defaultBranch: text("default_branch"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    /** How many marker files the crawl saw in this repo. */
    hitCount: integer("hit_count").notNull().default(1),
    /** Sample paths, so a curator can judge without fetching. */
    samplePaths: text("sample_paths").array(),

    status: discoveredRepoStatus("status").notNull().default("new"),
    skipReason: text("skip_reason"),
    /** Set once promoted into `sources` and therefore syncable. */
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Total bytes of marker files seen — a cheap size signal before fetching. */
    byteSize: bigint("byte_size", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("discovered_repos_uq").on(t.host, t.owner, t.repo),
    index("discovered_repos_status_idx").on(t.status, t.stars),
    index("discovered_repos_fork_idx").on(t.isFork),
  ],
);
