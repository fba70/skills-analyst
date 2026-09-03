import "server-only";

import { and, notInArray, sql, type SQL } from "drizzle-orm";

import { sources } from "@/server/db/schema";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Case-folded repository identity.
 *
 * ## The bug this exists to close
 *
 * GitHub resolves `owner/repo` **case-insensitively** — `github.com/NVIDIA/skills` and
 * `github.com/nvidia/skills` are one repository. Our tables treated them as two, because
 * every identity comparison in the ingest path was an exact string `=` and both unique
 * indexes (`sources_public_url_uq` on `url`, `discovered_repos_uq` on `owner, repo`) were
 * case-sensitive.
 *
 * The result, measured on 2026-09-03: **15 repositories held two `sources` rows each**.
 * `NVIDIA/skills` had 268 indexed skills and `nvidia/skills` another 99 — the same
 * repository fetched twice, its skills split across two rows, its GitHub quota spent twice,
 * and both rows counted separately in every per-source statistic. Archetype banding read
 * the split as one curated source and one untrusted one.
 *
 * Nothing errored. Two rows is what the schema said was allowed.
 *
 * ## Fold in comparisons, keep the casing in the row
 *
 * The stored `name` and `url` keep whatever casing GitHub reported, because that is what a
 * reader and an attribution list should see — `NVIDIA/skills`, not `nvidia/skills`. Only
 * the *comparison* folds. That is also why this is a predicate helper rather than a
 * normaliser that rewrites the column: rewriting would make the display wrong to fix the
 * lookup, and would still leave the next call site free to compare exactly.
 *
 * The unique indexes added in migration 0021 fold the same way, so a call site that forgets
 * this helper now gets a constraint violation instead of quietly creating the second row.
 * Belt and braces on purpose: the index is what makes the guarantee, the helper is what
 * keeps the code from hitting it.
 */

/** Lower-cased comparison key for a repository URL. */
export function foldRepoUrl(url: string): string {
  return url.toLowerCase();
}

/**
 * `lower(column) = lower(value)` — the case-insensitive form of `eq(column, value)`.
 *
 * Matches the expression in the `lower(url)` unique indexes, so a lookup written with this
 * can use the index rather than sequentially scanning 909 rows.
 */
export function sameRepoUrl(column: PgColumn, url: string): SQL {
  return sql`lower(${column}) = ${foldRepoUrl(url)}`;
}

/** `lower(column) = lower(value)` for a bare owner or repo segment. */
export function sameRepoSegment(column: PgColumn, value: string): SQL {
  return sql`lower(${column}) = ${value.toLowerCase()}`;
}

/**
 * Kinds that are read for the links inside them, never for content.
 *
 * `expandList` reads an `awesome_list` source for repo URLs; `pendingSources` excludes it
 * because syncing one would try to ingest the list repository's own README as a skill.
 */
export const DISCOVERY_ONLY_KINDS = ["awesome_list", "github_code_search"] as const;

/**
 * "The source that holds this repository's content", which is not the same as
 * "the source at this URL" any more.
 *
 * Migration 0021 put `kind` into `sources_public_url_uq` so that one repository could be
 * both a curated **list** and a content repo — `ComposioHQ/awesome-claude-skills` is on the
 * seed list allow-list *and* ships six skills of its own, and folding the case without
 * `kind` would have forced one of those rows to be deleted.
 *
 * That was right, and it quietly removed a guarantee twelve call sites were relying on.
 * Every one of them resolved a source by URL with `limit(1)` and no ordering, which was
 * exactly one row by construction and is now a coin flip. The worst case is silent:
 * `promote()` returning the list row sets `discovered_repos.source_id` to it, skips
 * creating the content source, and marks the candidate `promoted` — while `pendingSources`
 * filters `awesome_list` out, so the repository reads as done and is never fetched. No
 * error, no held row.
 *
 * The four UPDATEs are the same shape in reverse: `rejectRepo` paused *both* rows, which
 * stops `expandList` re-reading a curated list nobody rejected, and `seed-run`'s
 * `onConflictDoNothing` means a later `pnpm seed --lists` cannot re-enable it.
 *
 * So every lookup that means "content" says so, and the ones that mean "any row at this
 * URL" — only the curator queue's display join — say that instead.
 */
export function contentSourceAt(url: string): SQL {
  // notInArray, not an array interpolated into raw SQL: binding a JS array inside a `sql`
  // template renders a single parameter and Postgres rejects it.
  return and(sameRepoUrl(sources.url, url), notInArray(sources.kind, [...DISCOVERY_ONLY_KINDS]))!;
}
