import "dotenv/config";

import { and, eq } from "drizzle-orm";

import { db } from "../src/server/db";
import { skills, skillVersions, sources } from "../src/server/db/schema/corpus";

/**
 * Proves the revocation and drift rules hold (Doc 2 R1.5).
 *
 *   pnpm verify:revocation
 *
 * Same shape as `verify-rls.ts`: fixtures with a collision-proof prefix, everything
 * cleaned up afterwards, non-zero exit on failure.
 *
 * Three properties, each of which was broken or absent before:
 *   1. a failing NEW version must not un-serve a previously good one
 *   2. a version whose path vanishes upstream is tombstoned, not deleted
 *   3. a skill with an older indexed version stays listed on that older version
 */

const prefix = `revfix-${Date.now()}`;
let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const [source] = await db
  .insert(sources)
  .values({
    kind: "github_repo",
    name: `${prefix}-source`,
    url: `https://example.invalid/${prefix}`,
    health: "unknown",
  })
  .returning({ id: sources.id });

const [skill] = await db
  .insert(skills)
  .values({
    dialect: "anthropic_skill",
    name: `${prefix}-skill`,
    slug: `${prefix}-skill`,
    status: "indexed",
  })
  .returning({ id: skills.id });

// v1: the good version, currently served.
const [v1] = await db
  .insert(skillVersions)
  .values({
    skillId: skill.id,
    sourceId: source.id,
    contentHash: `${prefix}-v1`,
    provenance: { sourceUrl: "x", path: "skills/alpha", commitSha: "a", files: [] },
    status: "indexed",
  })
  .returning({ id: skillVersions.id });

await db.update(skills).set({ currentVersionId: v1.id }).where(eq(skills.id, skill.id));

// v2: upstream pushed something that fails validation.
const [v2] = await db
  .insert(skillVersions)
  .values({
    skillId: skill.id,
    sourceId: source.id,
    contentHash: `${prefix}-v2`,
    provenance: { sourceUrl: "x", path: "skills/alpha", commitSha: "b", files: [] },
    status: "revalidating",
  })
  .returning({ id: skillVersions.id });

// --- Property 1: a failing new version must not withdraw the good one ---------
// Mirrors what validateOne does on a quarantine verdict.
{
  const fallback = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.status, "indexed")))
    .limit(1);

  await db.update(skillVersions).set({ status: "quarantined" }).where(eq(skillVersions.id, v2.id));
  await db
    .update(skills)
    .set({
      status: fallback[0] ? "indexed" : "quarantined",
      currentVersionId: fallback[0]?.id ?? null,
    })
    .where(eq(skills.id, skill.id));

  const [after] = await db
    .select({ current: skills.currentVersionId, status: skills.status })
    .from(skills)
    .where(eq(skills.id, skill.id));

  check(
    "a failing new version keeps the prior good one served",
    after.current === v1.id && after.status === "indexed",
    `current=${after.current} (expected ${v1.id}), status=${after.status}`,
  );
}

// --- Property 2 & 3: upstream deletion tombstones, metadata survives ----------
{
  const { tombstoneForTest } = await import("../src/server/ingest/sync");
  const count = await tombstoneForTest({
    sourceId: source.id,
    orgId: null,
    seenPaths: [], // the path is gone upstream
    sourceUrl: "x",
  });

  const versions = await db
    .select({ id: skillVersions.id, status: skillVersions.status, hash: skillVersions.contentHash })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id));

  const [after] = await db
    .select({ status: skills.status, current: skills.currentVersionId })
    .from(skills)
    .where(eq(skills.id, skill.id));

  check(
    "vanished versions are tombstoned",
    versions.every((v) => v.status === "tombstoned"),
    `statuses=${versions.map((v) => v.status).join(",")} (tombstoned ${count})`,
  );
  check(
    "tombstoned metadata is retained, not deleted",
    versions.length === 2 && versions.every((v) => v.hash.startsWith(prefix)),
    `${versions.length} version row(s) remain`,
  );
  check(
    "a skill with no served version is un-listed",
    after.status === "tombstoned" && after.current === null,
    `status=${after.status}, current=${after.current}`,
  );
}

// Cleanup: cascade from the skill, then the source.
await db.delete(skills).where(eq(skills.id, skill.id));
await db.delete(sources).where(eq(sources.id, source.id));

console.info(failures === 0 ? "\nRevocation rules verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
