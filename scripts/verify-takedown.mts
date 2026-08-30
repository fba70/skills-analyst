import "dotenv/config";

import { eq, inArray } from "drizzle-orm";

import { db } from "../src/server/db";
// Imported from the leaf modules, not the barrel: `schema/index.ts` re-exports with
// `export *`, which tsx's ESM loader cannot resolve statically from a script.
import { takedowns } from "../src/server/db/schema/compliance";
import { skills, skillVersions, sources } from "../src/server/db/schema/corpus";
import { user } from "../src/server/db/schema/auth";
import {
  activeBlocks,
  recordForTest,
  rejectForTest,
  reinstateForTest,
  upholdForTest,
} from "../src/server/compliance/takedown";
import { buildBundle } from "../src/server/skills/export";

/**
 * Proves the takedown rules hold (Doc 2 R7.5).
 *
 *   pnpm verify:takedown
 *
 * Same shape as `verify:revocation`: fixtures with a collision-proof prefix, everything
 * cleaned up afterwards, non-zero exit on failure. No network — the fixtures are never
 * stored in R2, and the one deletion path exercised is the one that decides *not* to
 * delete.
 *
 * The properties, in the order they would fail in production:
 *
 *   1. an undecided notice withdraws nothing — otherwise anyone who can send an email can
 *      un-list a competitor;
 *   2. upholding withdraws the skill and every version of it;
 *   3. the block is readable by the sync path, which is the only thing that makes it last;
 *   4. a re-sync's tombstone sweep does not touch a withdrawn version;
 *   5. download is refused as `withdrawn`, so the route answers 451 rather than 409;
 *   6. a skill the takedown does not name is untouched;
 *   7. a rejected notice blocks nothing;
 *   8. reinstating lifts the block;
 *   9. a source-scoped takedown covers the whole repository and disables it.
 */

const prefix = `tdfix-${Date.now()}`;
let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

// `takedowns.decided_by` is a real foreign key, so the fixture needs a real user. Any one
// will do — the property under test is what the decision does, not who made it.
const [actor] = await db.select({ id: user.id }).from(user).limit(1);
if (!actor) {
  console.info("\nNo user rows: sign in once, or run `pnpm admin:grant`, then re-run.\n");
  process.exit(1);
}

const sourceUrl = `https://example.invalid/${prefix}`;
const [source] = await db
  .insert(sources)
  .values({ kind: "github_repo", name: `${prefix}-source`, url: sourceUrl, health: "unknown" })
  .returning({ id: sources.id });

/** The skill the notice is about. */
const [target] = await db
  .insert(skills)
  .values({
    dialect: "anthropic_skill",
    name: `${prefix}-target`,
    slug: `${prefix}-target`,
    status: "indexed",
  })
  .returning({ id: skills.id });

/**
 * A second skill in the same repository, to prove the blast radius is what was named.
 *
 * It cannot share the first one's bytes: `skill_versions` has a unique index on
 * `content_hash` — R1.4's dedup — and two live versions with one hash is a state the
 * database refuses. That is also why nothing here exercises the branch of
 * `deleteStoredBundles` that spares a shared bundle: the precondition is unreachable, and a
 * fixture faking it would prove the fixture works rather than the code.
 *
 * No fixture is stored in R2 either, so nothing here reaches the network.
 */
const targetHash = `${prefix}-targethash`;
const [bystander] = await db
  .insert(skills)
  .values({
    dialect: "anthropic_skill",
    name: `${prefix}-bystander`,
    slug: `${prefix}-bystander`,
    status: "indexed",
  })
  .returning({ id: skills.id });

const [targetV1] = await db
  .insert(skillVersions)
  .values({
    skillId: target.id,
    sourceId: source.id,
    contentHash: targetHash,
    // The storage link is set so the test can assert it gets *cleared*; `contentStored`
    // stays false so upholding never calls out to R2.
    contentStored: false,
    storageKey: `public/sha256/${targetHash}/`,
    provenance: { sourceUrl, path: "skills/alpha", commitSha: "a", files: [] },
    status: "indexed",
  })
  .returning({ id: skillVersions.id });

await db.update(skills).set({ currentVersionId: targetV1.id }).where(eq(skills.id, target.id));

const [bystanderV1] = await db
  .insert(skillVersions)
  .values({
    skillId: bystander.id,
    sourceId: source.id,
    contentHash: `${prefix}-bystanderhash`,
    contentStored: false,
    storageKey: null,
    provenance: { sourceUrl, path: "skills/beta", commitSha: "a", files: [] },
    status: "indexed",
  })
  .returning({ id: skillVersions.id });

await db
  .update(skills)
  .set({ currentVersionId: bystanderV1.id })
  .where(eq(skills.id, bystander.id));

const skillTakedown = await recordForTest(
  {
    scope: "skill",
    sourceUrl,
    skillPath: "skills/alpha",
    skillId: target.id,
    sourceId: source.id,
    requester: `${prefix}-claimant`,
    grounds: "copyright",
    claim: "Fixture claim.",
  },
  actor.id,
);

// --- Property 1: a logged notice enforces nothing -----------------------------
{
  const blocks = await activeBlocks(sourceUrl);
  check(
    "an undecided notice blocks nothing",
    !blocks.sourceBlocked && blocks.paths.size === 0,
    `sourceBlocked=${blocks.sourceBlocked}, paths=${[...blocks.paths].join(",")}`,
  );
}

// --- Properties 2 and 6: uphold withdraws, and only what it named ------------
{
  const result = await upholdForTest(skillTakedown, actor.id, "Fixture decision.");

  const [after] = await db
    .select({ status: skills.status, current: skills.currentVersionId })
    .from(skills)
    .where(eq(skills.id, target.id));

  const [version] = await db
    .select({ status: skillVersions.status, stored: skillVersions.contentStored, key: skillVersions.storageKey })
    .from(skillVersions)
    .where(eq(skillVersions.id, targetV1.id));

  check(
    "upholding withdraws the skill and un-serves it",
    after.status === "withdrawn" && after.current === null,
    `status=${after.status}, current=${after.current}`,
  );
  check(
    "the version is withdrawn and its storage link cleared",
    version.status === "withdrawn" && version.stored === false && version.key === null,
    `status=${version.status}, stored=${version.stored}, key=${version.key}`,
  );
  check(
    "nothing is deleted from storage when nothing was stored",
    result.bundlesDeleted === 0 && result.bundlesShared === 0,
    `deleted=${result.bundlesDeleted}, shared=${result.bundlesShared}`,
  );

  const [other] = await db
    .select({ status: skills.status })
    .from(skills)
    .where(eq(skills.id, bystander.id));
  check(
    "a skill the takedown does not name is untouched",
    other.status === "indexed",
    `status=${other.status}`,
  );
}

// --- Property 3: the sync path can see the block ------------------------------
{
  const blocks = await activeBlocks(sourceUrl);
  check(
    "the withdrawn path is blocked from re-ingestion",
    blocks.paths.has("skills/alpha") && !blocks.sourceBlocked,
    `paths=${[...blocks.paths].join(",")}, sourceBlocked=${blocks.sourceBlocked}`,
  );
}

// --- Property 4: a re-sync's tombstone sweep must not touch it ----------------
{
  const { tombstoneForTest } = await import("../src/server/ingest/sync");
  // An empty `seenPaths` is the strongest case: the sweep believes everything vanished.
  await tombstoneForTest({ sourceId: source.id, orgId: null, seenPaths: [], sourceUrl });

  const [version] = await db
    .select({ status: skillVersions.status })
    .from(skillVersions)
    .where(eq(skillVersions.id, targetV1.id));

  check(
    "the tombstone sweep leaves a withdrawn version alone",
    version.status === "withdrawn",
    `status=${version.status} — a sweep re-labelled a takedown`,
  );
}

// --- Property 5: download refuses with the right reason -----------------------
{
  const refusal = await buildBundle({
    slug: `${prefix}-target`,
    name: `${prefix}-target`,
    dialect: "anthropic_skill",
    status: "withdrawn",
    qualityScore: 100,
    contentHash: targetHash,
    // Everything below would have passed the gate. The status is the only thing refusing,
    // which is what makes this a test of the takedown rather than of the licence check.
    contentStored: true,
    fileCount: 1,
    redistribution: "mirror_allowed",
    licenseSpdx: "MIT",
    provenance: { sourceUrl, path: "skills/alpha" },
    sourceUrl,
    syncedAt: new Date(),
    verdicts: [],
  });

  check(
    "a withdrawn skill is refused as `withdrawn`, not as `not-indexed`",
    refusal.ok === false && refusal.reason === "withdrawn",
    `ok=${refusal.ok}, reason=${"reason" in refusal ? refusal.reason : "-"}`,
  );
}

// --- Property 8: reinstating lifts the block ----------------------------------
{
  await reinstateForTest(skillTakedown, actor.id, "Fixture retraction.");

  const blocks = await activeBlocks(sourceUrl);
  const [version] = await db
    .select({ status: skillVersions.status })
    .from(skillVersions)
    .where(eq(skillVersions.id, targetV1.id));

  check(
    "reinstating lifts the block",
    !blocks.paths.has("skills/alpha"),
    `paths=${[...blocks.paths].join(",")}`,
  );
  check(
    "a reinstated version rests at tombstoned, not indexed",
    version.status === "tombstoned",
    `status=${version.status} — content was deleted, so indexed would be a lie`,
  );
}

// --- Property 7: a rejected notice enforces nothing ----------------------------
{
  const rejected = await recordForTest(
    {
      scope: "skill",
      sourceUrl,
      skillPath: "skills/beta",
      skillId: bystander.id,
      sourceId: source.id,
      requester: `${prefix}-claimant-2`,
      grounds: "other",
      claim: "Fixture claim, to be refused.",
    },
    actor.id,
  );
  await rejectForTest(rejected, actor.id, "Fixture rejection.");

  const blocks = await activeBlocks(sourceUrl);
  const [after] = await db
    .select({ status: skills.status })
    .from(skills)
    .where(eq(skills.id, bystander.id));

  /*
   * The block is the assertion; the skill's status is not.
   *
   * Property 4 ran the tombstone sweep with an empty `seenPaths`, which correctly
   * tombstoned every path in this fixture source — the bystander included. Asserting
   * `indexed` here would be asserting that an earlier test had not run. That the rejection
   * left the bystander alone is already covered above, before the sweep.
   */
  check(
    "a rejected notice blocks nothing",
    !blocks.paths.has("skills/beta") && after.status !== "withdrawn",
    `paths=${[...blocks.paths].join(",")}, bystander=${after.status}`,
  );
}

// --- Property 9: a source-scoped takedown covers the repository ----------------
{
  const wholeRepo = await recordForTest(
    {
      scope: "source",
      sourceUrl,
      sourceId: source.id,
      requester: `${prefix}-owner`,
      grounds: "author_request",
      claim: "Please stop mirroring this repository.",
    },
    actor.id,
  );
  const result = await upholdForTest(wholeRepo, actor.id, "Fixture decision.");

  const blocks = await activeBlocks(sourceUrl);
  const [src] = await db
    .select({ enabled: sources.enabled, health: sources.health })
    .from(sources)
    .where(eq(sources.id, source.id));

  check(
    "a source-scoped takedown blocks the whole repository",
    blocks.sourceBlocked,
    `sourceBlocked=${blocks.sourceBlocked}`,
  );
  check(
    "the source is disabled, so the scheduler stops offering it",
    src.enabled === false && src.health === "paused",
    `enabled=${src.enabled}, health=${src.health}`,
  );
  check(
    "it covers every skill in the repository, not just the one named",
    result.affectedSkills === 2,
    `affectedSkills=${result.affectedSkills} (expected 2)`,
  );
}

// Cleanup.
await db.delete(takedowns).where(eq(takedowns.sourceUrl, sourceUrl));
await db.delete(skills).where(inArray(skills.id, [target.id, bystander.id]));
await db.delete(sources).where(eq(sources.id, source.id));

console.info(failures === 0 ? "\nTakedown rules verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
