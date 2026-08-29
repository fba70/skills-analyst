import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { githubConnector } from "@/server/connectors/github";
import type { Connector, SourceConfig } from "@/server/connectors/types";
import { discoveryPolicy } from "@/server/crawl/policy";
import { db } from "@/server/db";
import {
  discoveredRepos,
  events,
  skills,
  skillSignals,
  skillVersions,
  sources,
} from "@/server/db/schema";
import { resolveLicense } from "@/server/licensing/resolve";
import { normalizeSkill } from "@/server/skills/normalize";
import {
  bundlePrefix,
  digestBundle,
  mayMirror,
  storeBundle,
  type StorageTier,
} from "@/server/storage";

/**
 * One sync pass over one source.
 *
 * The order is the point: fetch, normalise, resolve the licence, hash, and only then
 * decide whether the bytes may be written. Analysis never depends on mirroring, so a
 * skill we may not copy is still indexed, still gets verdicts, and still counts in
 * corpus statistics — it simply has no bytes on our disk.
 *
 * Idempotent by `content_hash`: re-running touches `last_seen_at` and writes nothing
 * else. That is what makes an interrupted run safe to repeat.
 *
 * Nothing here reaches `indexed`. Versions land as `pending` and validation (1d) is what
 * promotes them — fail-closed by construction, not by remembering to check.
 */

const CONNECTORS: Record<string, Connector> = {
  github_repo: githubConnector,
};

/** Connector signal names -> the `signal_kind` enum. Not the same spelling. */
const SIGNAL_KINDS: Record<string, "stars" | "forks" | "watchers" | "open_issues"> = {
  stars: "stars",
  forks: "forks",
  watchers: "watchers",
  openIssues: "open_issues",
};

export type SyncOptions = {
  sourceUrl: string;
  /** Restrict to path prefixes, e.g. ["skills/"]. */
  includePaths?: string[];
  ref?: string;
  /** Public corpus when null. */
  orgId?: string | null;
  /** Walk everything but write nothing — for inspecting a source before trusting it. */
  dryRun?: boolean;
  /** Stop after N skills. Useful on a first look at a large repo. */
  limit?: number;
  /**
   * Sync a repository that exceeds the marker-count threshold anyway. Off by default and
   * never set by the automated path — this is for a human who has looked and decided.
   */
  allowLargeRepo?: boolean;
  onProgress?: (message: string) => void;
};

export type SyncedSkill = {
  path: string;
  name: string;
  slug: string;
  dialect: string;
  contentHash: string;
  licenseSpdx: string | null;
  redistribution: string;
  licenseSource: string;
  licenseFrom: string | null;
  contentStored: boolean;
  fileCount: number;
  byteSize: number;
  outcome: "created" | "unchanged" | "dry-run";
  parseError: string | null;
};

export type SyncReport = {
  sourceUrl: string;
  commitSha: string | null;
  skills: SyncedSkill[];
  signals: Record<string, number>;
  created: number;
  unchanged: number;
};

/**
 * Sources that have never completed a sync, newest promotions first.
 *
 * Kept here rather than in the CLI because the cron dispatcher will need exactly the same
 * query — the trigger changes, the selection should not.
 */
export async function pendingSources(limit = 10) {
  return db
    .select({ id: sources.id, url: sources.url, name: sources.name })
    .from(sources)
    .where(and(isNull(sources.lastSuccessAt), eq(sources.enabled, true)))
    .orderBy(sources.createdAt)
    .limit(limit);
}

export async function syncSource(options: SyncOptions): Promise<SyncReport> {
  const orgId = options.orgId ?? null;
  const log = options.onProgress ?? (() => {});

  const config: SourceConfig = {
    url: options.sourceUrl,
    ref: options.ref,
    includePaths: options.includePaths,
  };

  // A curator approval is stored on the source, not passed by the caller — so the
  // scheduled path honours it too, not just a hand-run command.
  const [sourceRow] = await db
    .select({ config: sources.config })
    .from(sources)
    .where(eq(sources.url, options.sourceUrl))
    .limit(1);
  const approvedLarge =
    ((sourceRow?.config as Record<string, unknown> | undefined)?.allowLargeRepo as boolean) ===
    true;

  const connector = CONNECTORS.github_repo;
  log(`enumerating ${options.sourceUrl}`);
  const enumerated = await connector.enumerate(config, null);
  log(`found ${enumerated.refs.length} skill(s)`);

  /**
   * Re-check the marker count against the real tree.
   *
   * Promotion applies this same threshold to the count code search *sampled*, which is
   * one shard's worth — `pm-claude-skills` showed 11 markers at discovery and actually
   * holds 3,551. Discovery guesses; the tree knows. Checking only at discovery let a
   * clone farm through and turned one source into thousands of file fetches.
   *
   * Held for review rather than skipped, and the source is disabled so the queue stops
   * retrying it — the same posture as promotion, for the same reason: it may still hold
   * real skills.
   */
  if (
    !options.allowLargeRepo &&
    !approvedLarge &&
    !options.dryRun &&
    enumerated.refs.length > discoveryPolicy.markerCountReviewThreshold
  ) {
    await holdForReview(options.sourceUrl, enumerated.refs.length, orgId);
    throw new Error(
      `${options.sourceUrl} holds ${enumerated.refs.length} skills, over the ` +
        `${discoveryPolicy.markerCountReviewThreshold} threshold — held for review, ` +
        `source disabled. Re-run with allowLargeRepo to sync it anyway.`,
    );
  }

  const refs = options.limit ? enumerated.refs.slice(0, options.limit) : enumerated.refs;
  const report: SyncReport = {
    sourceUrl: options.sourceUrl,
    commitSha: refs[0]?.commitSha ?? null,
    skills: [],
    signals: Object.fromEntries(
      Object.entries(enumerated.signals).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    created: 0,
    unchanged: 0,
  };

  const sourceId = options.dryRun
    ? null
    : await upsertSource(options.sourceUrl, orgId, enumerated.repoLicenseSpdx);

  for (const ref of refs) {
    const fetched = await connector.fetch(config, ref);
    const dirName = ref.path.split("/").pop() || "root";

    const marker = fetched.files[0];
    const normalized = normalizeSkill({
      dialect: ref.dialect,
      dirName,
      markerContent: marker.content,
    });

    const license = resolveLicense({
      frontmatterLicense: normalized.frontmatterLicense,
      licenseFiles: fetched.licenseFiles.map((file) => ({
        path: file.path,
        text: file.content.toString("utf8"),
      })),
      repoLicenseSpdx: enumerated.repoLicenseSpdx,
    });

    // Hash first, always. Storing is the only part the licence gate can withhold, and a
    // dry run must still report the hash and the decision it *would* make.
    const tier: StorageTier = "public";
    const digest = digestBundle(fetched.files);
    const permitted = mayMirror(license.posture);
    const stored = options.dryRun
      ? {
          ...digest,
          storageKey: permitted ? bundlePrefix(tier, digest.contentHash) : null,
          contentStored: permitted,
        }
      : await storeBundle({
          files: fetched.files,
          tier,
          redistribution: license.posture,
          licenseSpdx: license.spdx,
        });

    const entry: SyncedSkill = {
      path: ref.path,
      name: normalized.name,
      slug: normalized.slug,
      dialect: normalized.dialect,
      contentHash: stored.contentHash,
      licenseSpdx: license.spdx,
      redistribution: license.posture,
      licenseSource: license.source,
      licenseFrom: license.evidence.from,
      contentStored: stored.contentStored,
      fileCount: stored.fileCount,
      byteSize: stored.byteSize,
      outcome: "dry-run",
      parseError: normalized.parseError,
    };

    if (!options.dryRun && sourceId) {
      const outcome = await writeSkillVersion({
        orgId,
        sourceId,
        ref,
        normalized,
        license,
        stored,
        sourceUrl: options.sourceUrl,
        signals: enumerated.signals,
      });
      entry.outcome = outcome;
      if (outcome === "created") report.created += 1;
      else report.unchanged += 1;
    }

    report.skills.push(entry);
    log(`  ${entry.outcome.padEnd(9)} ${ref.path || "."} — ${entry.redistribution}`);
  }

  if (!options.dryRun && sourceId) {
    await db
      .update(sources)
      .set({ lastSyncAt: new Date(), lastSuccessAt: new Date(), health: "healthy" })
      .where(eq(sources.id, sourceId));
  }

  return report;
}

/** First free slug: `name`, then `name-2`, `name-3`, … within the same corpus. */
async function uniqueSlug(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  base: string,
  orgId: string | null,
): Promise<string> {
  for (let attempt = 1; attempt < 500; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const [taken] = await tx
      .select({ id: skills.id })
      .from(skills)
      .where(
        and(
          eq(skills.slug, candidate),
          orgId === null ? isNull(skills.orgId) : eq(skills.orgId, orgId),
        ),
      )
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Disables a source and returns its candidate row to the review queue, with the reason. */
async function holdForReview(
  url: string,
  markerCount: number,
  orgId: string | null,
): Promise<void> {
  const reason = `${markerCount} skills in one repository — over the ${discoveryPolicy.markerCountReviewThreshold} threshold`;

  await db.transaction(async (tx) => {
    await tx
      .update(sources)
      .set({ enabled: false, health: "paused", healthDetail: { reason }, updatedAt: new Date() })
      .where(eq(sources.url, url));

    await tx
      .update(discoveredRepos)
      .set({ status: "needs_review", skipReason: reason })
      .where(eq(discoveredRepos.url, url));

    await tx.insert(events).values({
      orgId,
      actorType: "system",
      actorId: "ingest",
      kind: "source.held_for_review",
      subjectType: "sources",
      subjectId: null,
      reason,
      payload: { url, markerCount, threshold: discoveryPolicy.markerCountReviewThreshold },
    });
  });
}

async function upsertSource(
  url: string,
  orgId: string | null,
  repoLicenseSpdx: string | null,
): Promise<string> {
  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.url, url), orgId === null ? isNull(sources.orgId) : eq(sources.orgId, orgId)))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const [row] = await db
    .insert(sources)
    .values({
      orgId,
      kind: "github_repo",
      name: url.replace(/^https?:\/\/(www\.)?github\.com\//i, ""),
      url,
      config: { repoLicenseSpdx },
      health: "healthy",
    })
    .returning({ id: sources.id });

  return row.id;
}

type WriteInput = {
  orgId: string | null;
  sourceId: string;
  ref: { path: string; commitSha: string; files: string[] };
  normalized: ReturnType<typeof normalizeSkill>;
  license: ReturnType<typeof resolveLicense>;
  stored: Awaited<ReturnType<typeof storeBundle>>;
  sourceUrl: string;
  signals: Record<string, number | undefined>;
};

async function writeSkillVersion(input: WriteInput): Promise<"created" | "unchanged"> {
  const { orgId, sourceId, ref, normalized, license, stored } = input;

  return db.transaction(async (tx) => {
    if (orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    }

    // Dedup (R1.4): identical bytes from any source collapse to the existing version.
    const [duplicate] = await tx
      .select({ id: skillVersions.id, skillId: skillVersions.skillId })
      .from(skillVersions)
      .where(eq(skillVersions.contentHash, stored.contentHash))
      .limit(1);

    if (duplicate) {
      await tx
        .update(skills)
        .set({ lastSeenAt: new Date() })
        .where(eq(skills.id, duplicate.skillId));
      return "unchanged" as const;
    }

    /**
     * Skill identity is (source, path) — the same directory in the same repo is the same
     * skill across syncs, so changed content becomes a new *version* rather than a second
     * skill. Slug is not identity: two unrelated repos both ship a "pdf" skill, and those
     * really are different skills.
     */
    const [existing] = await tx
      .select({ id: skills.id })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .where(
        and(
          eq(skillVersions.sourceId, sourceId),
          sql`${skillVersions.provenance}->>'path' = ${ref.path}`,
        ),
      )
      .limit(1);

    let skillId: string;
    if (existing) {
      skillId = existing.id;
      await tx
        .update(skills)
        .set({
          lastSeenAt: new Date(),
          name: normalized.name,
          summary: normalized.summary,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, skillId));
    } else {
      /**
       * Slugs must identify exactly one skill.
       *
       * The unique index is `(org_id, slug)` and Postgres treats NULLs as distinct, so
       * nothing stopped 66 public skills all being `agent-hiring-panel` — and
       * `/skills/agent-hiring-panel` then resolved to an arbitrary one. Suffix on
       * collision so the URL stays readable and unambiguous.
       */
      const slug = await uniqueSlug(tx, normalized.slug, orgId);
      const [created] = await tx
        .insert(skills)
        .values({
          orgId,
          dialect: normalized.dialect,
          name: normalized.name,
          slug,
          summary: normalized.summary,
          status: "pending",
        })
        .returning({ id: skills.id });
      skillId = created.id;
    }

    const [version] = await tx
      .insert(skillVersions)
      .values({
        orgId,
        skillId,
        sourceId,
        contentHash: stored.contentHash,
        storageKey: stored.storageKey,
        contentStored: stored.contentStored,
        byteSize: stored.byteSize,
        fileCount: stored.fileCount,
        frontmatter: normalized.frontmatter,
        provenance: {
          sourceUrl: input.sourceUrl,
          path: ref.path,
          commitSha: ref.commitSha,
          files: ref.files,
          fileHashes: stored.fileHashes,
          fetchedAt: new Date().toISOString(),
          parseError: normalized.parseError,
        },
        licenseSpdx: license.spdx,
        licenseSource: license.source,
        licenseEvidence: license.evidence,
        redistribution: license.posture,
        upstreamRef: ref.commitSha,
        status: "pending",
      })
      .returning({ id: skillVersions.id });

    for (const [key, value] of Object.entries(input.signals)) {
      if (typeof value !== "number") continue;
      const kind = SIGNAL_KINDS[key];
      // An unmapped key means the connector reports something the schema does not model
      // yet — skip it rather than crash the whole sync on one extra field.
      if (!kind) continue;
      await tx
        .insert(skillSignals)
        .values({ orgId, skillId, sourceId, kind, value: String(value) })
        .onConflictDoNothing();
    }

    await tx.insert(events).values({
      orgId,
      actorType: "system",
      actorId: "ingest",
      kind: "skill_version.created",
      subjectType: "skill_versions",
      subjectId: version.id,
      reason: `synced from ${input.sourceUrl}`,
      payload: {
        path: ref.path,
        commitSha: ref.commitSha,
        contentHash: stored.contentHash,
        redistribution: license.posture,
        licenseSource: license.source,
        contentStored: stored.contentStored,
      },
    });

    return "created" as const;
  });
}
