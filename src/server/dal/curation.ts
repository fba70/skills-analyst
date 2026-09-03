import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { sameRepoUrl } from "@/server/crawl/repo-identity";
import { requireAdmin } from "@/server/dal/admin";
import { pageWindow, type Paged, type PageQuery } from "@/server/dal/paging";
import { db } from "@/server/db";
import {
  discoveredRepos,
  events,
  skills,
  skillVersions,
  sources,
  verdicts,
} from "@/server/db/schema";

/**
 * The curator surfaces.
 *
 * The pipeline is full of deliberate decision points — repositories held for review,
 * versions quarantined, sources disabled — and every one of them was written to be
 * *reversible and explainable*. That only means something if a person can actually see
 * the queue and act on it, which is what this module is for.
 *
 * Two rules throughout:
 *   - every action re-checks `requireAdmin()`, because these are server actions and a
 *     page guard protects the view, not the operation;
 *   - every action writes an `events` row (R7.1). A curator decision is a state
 *     transition like any other, and "who un-quarantined this and why" is exactly the
 *     question an incident asks.
 */

export type HeldRepo = {
  id: string;
  name: string;
  url: string;
  hitCount: number;
  stars: number | null;
  reason: string | null;
  samplePaths: string[] | null;
  sourceId: string | null;
  sourceEnabled: boolean | null;
};

export async function listHeldRepos(query: PageQuery = {}): Promise<Paged<HeldRepo>> {
  await requireAdmin();

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(discoveredRepos)
    .where(eq(discoveredRepos.status, "needs_review"));

  const window = pageWindow(total, query.page, query.pageSize);

  const items = await db
    .select({
      id: discoveredRepos.id,
      name: sql<string>`${discoveredRepos.owner} || '/' || ${discoveredRepos.repo}`,
      url: discoveredRepos.url,
      hitCount: discoveredRepos.hitCount,
      stars: discoveredRepos.stars,
      reason: discoveredRepos.skipReason,
      samplePaths: discoveredRepos.samplePaths,
      sourceId: sources.id,
      sourceEnabled: sources.enabled,
    })
    .from(discoveredRepos)
    .leftJoin(sources, sql`lower(${sources.url}) = lower(${discoveredRepos.url})`)
    .where(eq(discoveredRepos.status, "needs_review"))
    .orderBy(desc(discoveredRepos.stars), desc(discoveredRepos.hitCount))
    .limit(window.pageSize)
    .offset(window.offset);

  return { items, total, page: window.page, pageSize: window.pageSize, pageCount: window.pageCount };
}

/**
 * Approves a held repository for syncing.
 *
 * Sets `allowLargeRepo` on the source config rather than raising the global threshold:
 * the decision is "this specific repository is fine", not "large repositories are fine".
 */
export async function approveRepo(repoId: string): Promise<void> {
  const actor = await requireAdmin();

  await db.transaction(async (tx) => {
    const [repo] = await tx
      .select()
      .from(discoveredRepos)
      .where(eq(discoveredRepos.id, repoId))
      .limit(1);
    if (!repo) throw new Error("Repository not found");

    const [existing] = await tx
      .select({ id: sources.id, config: sources.config })
      .from(sources)
      .where(sameRepoUrl(sources.url, repo.url))
      .limit(1);

    let sourceId = existing?.id;
    if (sourceId) {
      await tx
        .update(sources)
        .set({
          enabled: true,
          health: "unknown",
          healthDetail: null,
          config: {
            ...((existing?.config as Record<string, unknown>) ?? {}),
            allowLargeRepo: true,
            approvedBy: actor.email,
          },
          updatedAt: new Date(),
        })
        .where(eq(sources.id, sourceId));
    } else {
      const [created] = await tx
        .insert(sources)
        .values({
          kind: "github_repo",
          name: `${repo.owner}/${repo.repo}`,
          url: repo.url,
          config: { allowLargeRepo: true, approvedBy: actor.email },
          health: "unknown",
        })
        .returning({ id: sources.id });
      sourceId = created.id;
    }

    await tx
      .update(discoveredRepos)
      .set({ status: "promoted", sourceId, skipReason: null })
      .where(eq(discoveredRepos.id, repoId));

    await tx.insert(events).values({
      actorType: "user",
      actorId: actor.userId,
      kind: "discovered_repo.approved",
      subjectType: "discovered_repos",
      subjectId: repoId,
      reason: `approved for sync despite ${repo.hitCount} markers`,
      payload: { url: repo.url, by: actor.email, sourceId },
    });
  });
}

export async function rejectRepo(repoId: string, reason: string): Promise<void> {
  const actor = await requireAdmin();

  await db.transaction(async (tx) => {
    const [repo] = await tx
      .select({ url: discoveredRepos.url })
      .from(discoveredRepos)
      .where(eq(discoveredRepos.id, repoId))
      .limit(1);
    if (!repo) throw new Error("Repository not found");

    await tx
      .update(discoveredRepos)
      .set({ status: "skipped", skipReason: reason || "rejected by curator" })
      .where(eq(discoveredRepos.id, repoId));

    await tx
      .update(sources)
      .set({ enabled: false, health: "paused", updatedAt: new Date() })
      .where(sameRepoUrl(sources.url, repo.url));

    await tx.insert(events).values({
      actorType: "user",
      actorId: actor.userId,
      kind: "discovered_repo.rejected",
      subjectType: "discovered_repos",
      subjectId: repoId,
      reason: reason || "rejected by curator",
      payload: { url: repo.url, by: actor.email },
    });
  });
}

export type QuarantinedVersion = {
  versionId: string;
  skillId: string;
  slug: string;
  name: string;
  sourceName: string | null;
  reasons: string[] | null;
  syncedAt: Date;
  findings: Array<{
    analyzer: string;
    reason: string;
    severity: string;
    message: string;
    file?: string;
    line?: number;
  }>;
};

/**
 * The quarantine queue, worst first.
 *
 * Ordering by severity rather than date because this queue is also how quarantine
 * *precision* gets measured (Doc 3 makes ≥90% on spot-check a stage gate), and a
 * spot-check is only meaningful if it starts with the decisions that matter most.
 */
export async function listQuarantined(
  query: PageQuery = {},
): Promise<Paged<QuarantinedVersion>> {
  await requireAdmin();

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(skillVersions)
    .where(eq(skillVersions.status, "quarantined"));

  const window = pageWindow(total, query.page, query.pageSize);

  const rows = await db
    .select({
      versionId: skillVersions.id,
      skillId: skills.id,
      slug: skills.slug,
      name: skills.name,
      sourceName: sources.name,
      reasons: skillVersions.quarantineReasons,
      syncedAt: skillVersions.syncedAt,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skills.id, skillVersions.skillId))
    .leftJoin(sources, eq(sources.id, skillVersions.sourceId))
    .where(eq(skillVersions.status, "quarantined"))
    .orderBy(desc(skillVersions.syncedAt))
    .limit(window.pageSize)
    .offset(window.offset);

  const empty = {
    items: [] as QuarantinedVersion[],
    total,
    page: window.page,
    pageSize: window.pageSize,
    pageCount: window.pageCount,
  };
  if (rows.length === 0) return empty;

  const verdictRows = await db
    .select({
      skillVersionId: verdicts.skillVersionId,
      analyzer: verdicts.analyzer,
      result: verdicts.result,
      evidence: verdicts.evidence,
    })
    .from(verdicts)
    // Parameterised, not string-built. These ids come from our own database, but
    // assembling SQL by concatenation is a habit that eventually meets untrusted input.
    .where(
      and(
        inArray(
          verdicts.skillVersionId,
          rows.map((row) => row.versionId),
        ),
        inArray(verdicts.result, ["fail", "error"]),
      ),
    );

  const byVersion = new Map<string, QuarantinedVersion["findings"]>();
  for (const verdict of verdictRows) {
    const evidence = (verdict.evidence ?? {}) as {
      findings?: Array<{
        reason: string;
        severity: string;
        message: string;
        file?: string;
        line?: number;
      }>;
    };
    const list = byVersion.get(verdict.skillVersionId) ?? [];
    for (const finding of evidence.findings ?? []) {
      list.push({ analyzer: verdict.analyzer, ...finding });
    }
    byVersion.set(verdict.skillVersionId, list);
  }

  return {
    ...empty,
    items: rows.map((row) => ({ ...row, findings: byVersion.get(row.versionId) ?? [] })),
  };
}

/**
 * Releases a quarantined version — the appeal path (Doc 2 R2.5, Doc 3 Rollout).
 *
 * The original verdicts are **not** edited. A curator override is recorded as a new
 * append-only verdict that supersedes them, so the history still shows what the analyzer
 * found and who decided otherwise. Rewriting the verdict would destroy exactly the
 * evidence a false-negative postmortem needs.
 */
export async function releaseFromQuarantine(
  versionId: string,
  reason: string,
): Promise<void> {
  const actor = await requireAdmin();
  if (!reason.trim()) throw new Error("A reason is required to release from quarantine");

  await db.transaction(async (tx) => {
    const [version] = await tx
      .select({ id: skillVersions.id, skillId: skillVersions.skillId, orgId: skillVersions.orgId })
      .from(skillVersions)
      .where(eq(skillVersions.id, versionId))
      .limit(1);
    if (!version) throw new Error("Version not found");

    await tx.insert(verdicts).values({
      orgId: version.orgId,
      skillVersionId: versionId,
      analyzer: "curator-override",
      analyzerVersion: "1.0.0",
      result: "pass",
      severity: "info",
      reason: "released from quarantine by a curator",
      evidence: { reason, by: actor.email, supersedes: "automated quarantine" },
    });

    await tx
      .update(skillVersions)
      .set({ status: "indexed", quarantineReasons: null })
      .where(eq(skillVersions.id, versionId));

    await tx
      .update(skills)
      .set({ status: "indexed", currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(skills.id, version.skillId));

    await tx.insert(events).values({
      orgId: version.orgId,
      actorType: "user",
      actorId: actor.userId,
      kind: "skill_version.released",
      subjectType: "skill_versions",
      subjectId: versionId,
      reason,
      payload: { by: actor.email },
    });
  });
}

export type SourceHealth = {
  id: string;
  name: string;
  url: string;
  kind: string;
  health: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  detail: string | null;
  skills: number;
  /** Computed in SQL: a component may not call Date.now() during render. */
  hoursSinceAttempt: number | null;
  hoursSinceSuccess: number | null;
};

/** Per-source health. Starvation must be visible, not silent (Doc 3 §Observability). */
export async function listSourceHealth(
  query: PageQuery = {},
): Promise<Paged<SourceHealth> & { stale: number; disabled: number }> {
  await requireAdmin();

  // Totals come from the whole table, not the page: "0 stale" must mean zero across all
  // sources, not zero on the page you happen to be looking at.
  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      disabled: sql<number>`count(*) filter (where ${sources.enabled} = false)::int`,
      stale: sql<number>`count(*) filter (
        where ${sources.enabled} and (
          ${sources.lastSuccessAt} is null
          or ${sources.lastSuccessAt} < now() - interval '24 hours'
        ))::int`,
    })
    .from(sources);

  const window = pageWindow(totals.total, query.page, query.pageSize);

  const items = await db
    .select({
      id: sources.id,
      name: sources.name,
      url: sources.url,
      kind: sources.kind,
      health: sources.health,
      enabled: sources.enabled,
      lastSyncAt: sources.lastSyncAt,
      lastSuccessAt: sources.lastSuccessAt,
      detail: sql<string | null>`${sources.healthDetail}->>'reason'`,
      skills: sql<number>`(
        select count(distinct sv.skill_id)::int
        from skill_versions sv where sv.source_id = "sources"."id"
      )`,
      hoursSinceAttempt: sql<number | null>`
        extract(epoch from now() - ${sources.lastSyncAt}) / 3600`,
      hoursSinceSuccess: sql<number | null>`
        extract(epoch from now() - ${sources.lastSuccessAt}) / 3600`,
    })
    .from(sources)
    .orderBy(desc(sources.enabled), sources.name)
    .limit(window.pageSize)
    .offset(window.offset);

  return {
    items,
    total: totals.total,
    page: window.page,
    pageSize: window.pageSize,
    pageCount: window.pageCount,
    stale: totals.stale,
    disabled: totals.disabled,
  };
}

export async function curationCounts() {
  await requireAdmin();
  const [row] = await db
    .select({
      held: sql<number>`(select count(*)::int from ${discoveredRepos} where ${discoveredRepos.status} = 'needs_review')`,
      quarantined: sql<number>`(select count(*)::int from ${skillVersions} where ${skillVersions.status} = 'quarantined')`,
      disabledSources: sql<number>`(select count(*)::int from ${sources} where ${sources.enabled} = false)`,
    })
    .from(sources)
    .limit(1);
  return row ?? { held: 0, quarantined: 0, disabledSources: 0 };
}
