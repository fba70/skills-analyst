import "server-only";

import { sql, type SQL } from "drizzle-orm";
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
