import "dotenv/config";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { skills } from "../src/server/db/schema/corpus";

/**
 * Backfills unique slugs for skills ingested before slugs were made unique.
 *
 * Keeps the first-seen row's slug and suffixes the rest, so existing links to the oldest
 * entry keep working. Ordering is deterministic (first seen, then id) so a re-run is a
 * no-op rather than a reshuffle.
 *
 *   pnpm fix:slugs --dry-run
 *   pnpm fix:slugs
 */

const dryRun = process.argv.includes("--dry-run");

const collisions = await db.execute<{ slug: string; n: number }>(sql`
  select slug, count(*)::int as n
  from skills where org_id is null
  group by slug having count(*) > 1
  order by count(*) desc
`);

const rows = collisions.rows ?? [];
console.info(`\n${rows.length} colliding slug(s)`);

let renamed = 0;
for (const { slug } of rows) {
  const members = await db
    .select({ id: skills.id, firstSeenAt: skills.firstSeenAt })
    .from(skills)
    .where(and(eq(skills.slug, slug), isNull(skills.orgId)))
    .orderBy(asc(skills.firstSeenAt), asc(skills.id));

  // The first keeps the bare slug; the rest get a suffix.
  for (let i = 1; i < members.length; i += 1) {
    const candidate = `${slug}-${i + 1}`;
    if (!dryRun) {
      await db.update(skills).set({ slug: candidate }).where(eq(skills.id, members[i].id));
    }
    renamed += 1;
  }
}

console.info(
  `${dryRun ? "would rename" : "renamed"} ${renamed} skill(s)\n`,
);
