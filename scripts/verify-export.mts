import "dotenv/config";

import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

import { buildBundle, validationReportHash, type BundleInput } from "../src/server/skills/export";
import { db } from "../src/server/db";
import { skills, skillVersions } from "../src/server/db/schema/corpus";
import { verdicts } from "../src/server/db/schema/validation";
import { sources } from "../src/server/db/schema/corpus";
import { and, eq, sql } from "drizzle-orm";

/**
 * Proves the export contract (Doc 2 R8.2, R8.3, and R2.6's delivery half).
 *
 *   pnpm verify:export
 *
 * The properties that matter to a consumer, each checked against a real skill from the
 * corpus rather than a fixture — a fixture would prove the zip writer works and nothing
 * about whether the stored bundle, the licence gate and the verdicts line up.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

/**
 * Reads a real corpus row into the shape `buildBundle` takes.
 *
 * Straight through `db` rather than the DAL: the DAL reaches `next/navigation`, which a
 * plain node script cannot load. That is exactly why `buildBundle` takes its facts as an
 * argument instead of fetching them.
 */
async function pick(posture: string, stored: boolean): Promise<BundleInput | null> {
  const [row] = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      dialect: skills.dialect,
      status: skills.status,
      qualityScore: skills.qualityScore,
      versionId: skillVersions.id,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
      fileCount: skillVersions.fileCount,
      redistribution: skillVersions.redistribution,
      licenseSpdx: skillVersions.licenseSpdx,
      provenance: skillVersions.provenance,
      sourceUrl: sources.url,
      syncedAt: skillVersions.syncedAt,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
    .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
    .where(
      and(
        eq(skills.status, "indexed"),
        eq(skillVersions.redistribution, posture as "mirror_allowed"),
        eq(skillVersions.contentStored, stored),
      ),
    )
    .orderBy(sql`random()`)
    .limit(1);

  if (!row) return null;

  const verdictRows = await db
    .select({
      analyzer: verdicts.analyzer,
      analyzerVersion: verdicts.analyzerVersion,
      result: verdicts.result,
    })
    .from(verdicts)
    .where(eq(verdicts.skillVersionId, row.versionId));

  return { ...row, verdicts: verdictRows };
}

// --- A servable skill -------------------------------------------------------
const target = (await pick("attribution_required", true)) ?? (await pick("mirror_allowed", true));
if (!target) {
  console.error("No servable skill in the corpus to test against.");
  process.exit(1);
}
const servable = target.slug;

const result = await buildBundle(target);
check("a licensed, stored, indexed skill exports", result.ok, JSON.stringify(result).slice(0, 160));

if (result.ok) {
  const files = unzipSync(result.bytes);
  const names = Object.keys(files);

  check(
    "archive has a single top-level directory named for the skill",
    names.length > 0 && names.every((n) => n.startsWith(`${servable}/`)),
    names.slice(0, 4).join(", "),
  );
  check(
    "receipt is included",
    names.includes(`${servable}/SKILL-FOUNDRY.json`),
    names.join(", ").slice(0, 160),
  );

  const receipt = JSON.parse(new TextDecoder().decode(files[`${servable}/SKILL-FOUNDRY.json`]));
  check(
    "receipt carries the content hash the bundle was validated under",
    receipt.contentHash === result.contentHash,
    `${receipt.contentHash} vs ${result.contentHash}`,
  );
  check(
    "receipt carries a validation report hash matching its listed verdicts",
    receipt.validationReportHash === validationReportHash(receipt.verdicts),
    "recomputed hash differs from the recorded one",
  );
  check(
    "attribution notice present exactly when the licence requires it",
    (result.redistribution === "attribution_required") ===
      names.includes(`${servable}/ATTRIBUTION.txt`),
    `${result.redistribution} / ${names.includes(`${servable}/ATTRIBUTION.txt`)}`,
  );

  // R2.6: two downloads of the same skill must be identical bytes.
  const again = await buildBundle(target);
  check(
    "two exports of the same skill are byte-identical",
    again.ok &&
      createHash("sha256").update(result.bytes).digest("hex") ===
        createHash("sha256").update(again.bytes).digest("hex"),
    "archives differ between downloads",
  );
}

// --- A skill the licence forbids serving ------------------------------------
const blocked = (await pick("metadata_only", false)) ?? (await pick("unresolved", false));
if (blocked) {
  const refusal = await buildBundle(blocked);
  check(
    "a non-redistributable skill is refused, not served",
    !refusal.ok && refusal.reason === "not-licensed",
    refusal.ok ? "it was served" : `reason=${refusal.reason}`,
  );
  check(
    "the refusal points at the origin instead",
    !refusal.ok && Boolean(refusal.originUrl),
    "no origin offered",
  );
} else {
  console.info("SKIP  no metadata-only skill in the corpus to test the licence refusal");
}

// --- A skill that is not indexed --------------------------------------------
const quarantined = await buildBundle({ ...target, status: "quarantined" });
check(
  "a quarantined skill is refused",
  !quarantined.ok && quarantined.reason === "not-indexed",
  quarantined.ok ? "it was served" : "",
);

console.info(failures === 0 ? "\nExport contract verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
