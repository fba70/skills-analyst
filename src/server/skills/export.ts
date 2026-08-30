import "server-only";

import { createHash } from "node:crypto";

import { zipSync, type Zippable } from "fflate";

import { getBundleFile, getManifest, type RedistributionPosture } from "@/server/storage";

/**
 * Skill export (Doc 2 R8.2, R8.3).
 *
 * The delivery half of R2.6. Content-hash lockfile semantics are only a claim until
 * something actually hands a consumer the bytes: what is exported here is assembled from
 * the stored objects at `sha256/<hash>/…`, so the key *is* the hash the verdict covers and
 * the guarantee is structural rather than asserted.
 *
 * ## The licence gate is the first thing, not the last
 *
 * R1.6 permits analysis of everything and mirroring of only some. `metadata_only` and
 * `unresolved` skills have no stored copy at all — we fetched them, judged them in memory,
 * kept the verdict and the hash, and never wrote the text down. Attempting to export one is
 * not an error to handle downstream; it is a case that must be refused before any object is
 * read, and the refusal is a fact about the licence rather than about availability.
 *
 * ## What goes in the archive
 *
 * The bundle exactly as validated, plus two files we add:
 *
 *   - `SKILL-FOUNDRY.json` — provenance, licence, the content hash, and the **validation
 *     report hash**. R2.6 asks that a served bundle carry it, and a consumer can therefore
 *     check that what they hold is what a given verdict was issued against.
 *   - `ATTRIBUTION.txt`, for `attribution_required` licences only — rendered wherever
 *     content is shown, and an export is content being shown.
 *
 * Layout is preserved verbatim under a single top-level directory named for the skill, so
 * the archive drops into `.claude/skills/` unchanged (R8.3). No rewriting of paths: a
 * relative link inside SKILL.md has to keep resolving.
 *
 * ## Split in two on purpose
 *
 * `buildBundle` takes the facts and assembles the archive; `exportSkill` is the thin
 * wrapper that looks those facts up through the DAL. The split is not decoration — the DAL
 * reaches `next/navigation` (via `redirect` in the session module), which cannot be loaded
 * from a plain node script, so a verification script could not otherwise exercise any of
 * this. Assembly is the part with rules worth testing; the lookup is one call.
 */

/** The earliest timestamp the ZIP format can represent. See the `mtime` note below. */
const ZIP_EPOCH = Date.UTC(1980, 0, 1);

/** Postures whose bytes we are permitted to hand over. */
const EXPORTABLE: ReadonlySet<RedistributionPosture> = new Set([
  "mirror_allowed",
  "attribution_required",
]);

export type ExportRefusal = {
  ok: false;
  /** `not-found` | `not-licensed` | `not-stored` | `not-indexed` */
  reason: "not-found" | "not-licensed" | "not-stored" | "not-indexed";
  message: string;
  /** Where the consumer can get it themselves, when we may not serve it. */
  originUrl?: string;
};

export type ExportBundle = {
  ok: true;
  filename: string;
  bytes: Uint8Array;
  contentHash: string;
  /** Stable digest over the verdicts this bundle was validated under (R2.6). */
  reportHash: string;
  licenseSpdx: string | null;
  redistribution: RedistributionPosture;
};

/**
 * A stable digest of a skill version's verdicts.
 *
 * Sorted by analyzer so the hash does not depend on row order, and built only from the
 * fields that constitute the judgement — analyzer, its version, the result. Evidence is
 * excluded on purpose: it carries excerpts and line numbers that can change without the
 * verdict changing, and a report hash that moves when nothing was re-judged is noise a
 * consumer cannot act on.
 */
export function validationReportHash(
  verdicts: ReadonlyArray<{ analyzer: string; analyzerVersion: string; result: string }>,
): string {
  const canonical = [...verdicts]
    .map((v) => `${v.analyzer}@${v.analyzerVersion}=${v.result}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function attributionText(input: {
  name: string;
  sourceUrl: string | null;
  path: string | null;
  commitSha: string | null;
  licenseSpdx: string | null;
}): string {
  const origin = input.sourceUrl
    ? `${input.sourceUrl}${input.path ? `/tree/${input.commitSha ?? "HEAD"}/${input.path}` : ""}`
    : "(origin unrecorded)";

  return [
    `${input.name}`,
    ``,
    `Licence:   ${input.licenseSpdx ?? "see the bundled licence file"}`,
    `Origin:    ${origin}`,
    input.commitSha ? `Commit:    ${input.commitSha}` : null,
    ``,
    `This skill is redistributed under a licence that requires attribution.`,
    `Keep this notice with the skill wherever it is used or redistributed.`,
    ``,
    `Retrieved via Skill Foundry.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Everything `buildBundle` needs. Mirrors the shape `getSkillBySlug` already returns. */
export type BundleInput = {
  slug: string;
  name: string;
  dialect: string;
  status: string;
  qualityScore: number | null;
  contentHash: string;
  contentStored: boolean;
  fileCount: number | null;
  redistribution: string;
  licenseSpdx: string | null;
  provenance: unknown;
  sourceUrl: string | null;
  syncedAt: Date | string | null;
  verdicts: ReadonlyArray<{ analyzer: string; analyzerVersion: string; result: string }>;
};

export async function buildBundle(
  skill: BundleInput,
): Promise<ExportBundle | ExportRefusal> {
  const provenance = (skill.provenance ?? {}) as {
    sourceUrl?: string;
    path?: string;
    commitSha?: string;
  };
  const originUrl = provenance.sourceUrl ?? skill.sourceUrl ?? undefined;

  if (skill.status !== "indexed") {
    // Quarantined and tombstoned skills stay visible — their verdicts are the point — but
    // handing over bytes that failed the trust boundary is the one thing a registry built
    // on that boundary must not do.
    return {
      ok: false,
      reason: "not-indexed",
      message: `This skill is ${skill.status} and is not served for download.`,
      originUrl,
    };
  }

  const posture = skill.redistribution as RedistributionPosture;
  if (!EXPORTABLE.has(posture)) {
    return {
      ok: false,
      reason: "not-licensed",
      message:
        posture === "unresolved"
          ? "This skill's licence could not be resolved, so its content is not redistributed. Fetch it from the origin."
          : "This skill's licence does not permit redistribution. Fetch it from the origin.",
      originUrl,
    };
  }

  if (!skill.contentStored) {
    return {
      ok: false,
      reason: "not-stored",
      message: "No mirrored copy of this skill is available.",
      originUrl,
    };
  }

  const manifest = await getManifest("public", skill.contentHash);
  if (!manifest) {
    return {
      ok: false,
      reason: "not-stored",
      message: "The mirrored copy of this skill is unavailable.",
      originUrl,
    };
  }

  const reportHash = validationReportHash(skill.verdicts);

  // One top-level directory named for the skill, so the archive extracts into
  // `.claude/skills/<slug>/` rather than scattering files into the current directory.
  const root = skill.slug;
  const entries: Zippable = {};

  for (const path of Object.keys(manifest.files)) {
    const content = await getBundleFile("public", skill.contentHash, path);
    // A file in the manifest that is missing in storage is a real inconsistency, and
    // shipping a partial bundle would break the bit-identical guarantee this exists for.
    if (!content) {
      return {
        ok: false,
        reason: "not-stored",
        message: `The mirrored copy is incomplete (${path} is missing).`,
        originUrl,
      };
    }
    entries[`${root}/${path}`] = new Uint8Array(content);
  }

  const receipt = {
    skill: skill.name,
    slug: skill.slug,
    dialect: skill.dialect,
    qualityScore: skill.qualityScore,
    contentHash: skill.contentHash,
    validationReportHash: reportHash,
    verdicts: skill.verdicts.map((v) => ({
      analyzer: v.analyzer,
      analyzerVersion: v.analyzerVersion,
      result: v.result,
    })),
    license: { spdx: skill.licenseSpdx, redistribution: posture },
    provenance: {
      sourceUrl: originUrl ?? null,
      path: provenance.path ?? null,
      commitSha: provenance.commitSha ?? null,
      syncedAt: skill.syncedAt instanceof Date ? skill.syncedAt.toISOString() : null,
    },
    /**
     * Deliberately no `exportedAt`.
     *
     * A wall-clock stamp here would make every download of the same skill a different
     * archive, which costs the property that matters — a consumer being able to hash what
     * they received and compare it with what someone else received, or with what they
     * downloaded last week. It buys nothing in exchange: the consumer knows when they
     * downloaded it. `syncedAt` below is the timestamp with actual information in it.
     */
    note:
      "contentHash is the SHA-256 of the bundle as validated. validationReportHash covers " +
      "the analyzer verdicts listed above. Both are reproducible from this archive.",
  };

  entries[`${root}/SKILL-FOUNDRY.json`] = new TextEncoder().encode(
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  if (posture === "attribution_required") {
    entries[`${root}/ATTRIBUTION.txt`] = new TextEncoder().encode(
      `${attributionText({
        name: skill.name,
        sourceUrl: originUrl ?? null,
        path: provenance.path ?? null,
        commitSha: provenance.commitSha ?? null,
        licenseSpdx: skill.licenseSpdx,
      })}\n`,
    );
  }

  return {
    ok: true,
    filename: `${skill.slug}.zip`,
    /**
     * A fixed modification time keeps the archive byte-stable across downloads.
     *
     * Without it every export embeds the current clock and two downloads of the same skill
     * differ — which would make the integrity claim this whole module exists for
     * impossible for a consumer to check.
     *
     * 1980-01-01 rather than the epoch because the ZIP format cannot represent a date
     * before 1980; `mtime: 0` is rejected outright.
     */
    bytes: zipSync(entries, { level: 6, mtime: ZIP_EPOCH }),
    contentHash: skill.contentHash,
    reportHash,
    licenseSpdx: skill.licenseSpdx,
    redistribution: posture,
  };
}

/**
 * Looks a skill up and exports it. The DAL decides what is visible; `buildBundle` decides
 * what may be served.
 */
export async function exportSkill(slug: string): Promise<ExportBundle | ExportRefusal> {
  // Imported lazily so this module stays loadable outside a request context — the DAL
  // pulls in `next/navigation`, which a CLI script cannot evaluate.
  const { getSkillBySlug } = await import("@/server/dal/skills");
  const skill = await getSkillBySlug(slug);
  if (!skill) return { ok: false, reason: "not-found", message: "No such skill." };

  return buildBundle({
    slug: skill.slug,
    name: skill.name,
    dialect: skill.dialect,
    status: skill.status,
    qualityScore: skill.qualityScore,
    contentHash: skill.contentHash,
    contentStored: skill.contentStored,
    fileCount: skill.fileCount,
    redistribution: skill.redistribution,
    licenseSpdx: skill.licenseSpdx,
    provenance: skill.provenance,
    sourceUrl: skill.sourceUrl,
    syncedAt: skill.syncedAt,
    verdicts: skill.verdicts,
  });
}
