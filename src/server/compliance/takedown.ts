import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { sameRepoUrl } from "@/server/crawl/repo-identity";
import { db } from "@/server/db";
import { events, skills, skillVersions, sources, takedowns } from "@/server/db/schema";
import { deleteBundle } from "@/server/storage";
import { pageWindow, type Paged, type PageQuery } from "@/server/dal/paging";

/**
 * The takedown workflow (Doc 2 R7.5).
 *
 * We mirror other people's work under their licences. Doc 1 states the obligation to the
 * upstream authors we ingest — who never signed up — as structural rather than optional:
 * provenance, licence gating, quarantine with an appeal path, and a way to withdraw content
 * on request. This is the last of those, and it was the one that did not exist.
 *
 * ## The whole difficulty is that a sync must not undo it
 *
 * Withdrawing content is easy: the tombstone path (R1.5) already does it, and reusing it
 * would have looked finished. It would also have been wrong. A tombstone is *designed* to
 * reverse itself — the file went away upstream, and if it comes back the next enumeration
 * re-indexes it. Run that logic on a takedown and the content returns within 24 hours, on a
 * schedule, with nobody watching.
 *
 * So a takedown is a **persistent record consulted before fetching**, and the state on the
 * skill is a consequence of it rather than the thing itself. `activeBlocks` is the read
 * `syncSource` makes before it downloads anything.
 *
 * ## Not org-scoped through the DAL, on purpose
 *
 * Every mutating function re-checks `requireAdmin()`; these are reached from server actions,
 * and a page guard protects the view rather than the operation. `activeBlocks` is the one
 * exception and takes no session at all — it runs inside the sync pipeline, which is
 * background work with no org to declare, and a block that only applied to logged-in
 * requests would be no block.
 */

/**
 * `requireAdmin`, imported lazily — exactly as `dal/scope.ts` does, and for the same reason.
 *
 * `dal/admin` reaches `dal/session`, which reaches `next/navigation` for `redirect`, which
 * pulls in React's client runtime and throws on import in a plain node process. At module
 * scope that cost is paid by **every** consumer of this file — including `activeBlocks`,
 * which the sync pipeline calls and which needs no session at all. A verification script
 * touching only the block path would die on an import it never uses.
 */
async function admin() {
  const { requireAdmin } = await import("@/server/dal/admin");
  return requireAdmin();
}

/** Only these two statuses withhold content. `received` is logged but not yet enforced. */
const ENFORCING: ReadonlyArray<"upheld"> = ["upheld"];

export type TakedownInput = {
  scope: "skill" | "source";
  /** Resolved from the skill when scope is `skill`. */
  sourceUrl: string;
  skillPath?: string | null;
  skillId?: string | null;
  sourceId?: string | null;
  requester: string;
  requesterEmail?: string | null;
  grounds: "copyright" | "license_violation" | "privacy" | "trademark" | "author_request" | "other";
  claim: string;
};

/**
 * Logs a request without acting on it.
 *
 * Recording and deciding are separate steps because they are separate events. A notice that
 * arrives is a fact; whether it is honoured is a judgement made afterwards, and collapsing
 * the two would mean the only claims we can evidence are the ones we agreed with.
 */
export async function recordTakedown(input: TakedownInput): Promise<string> {
  const actor = await admin();
  return applyRecord(input, actor.userId);
}

async function applyRecord(input: TakedownInput, actorId: string): Promise<string> {
  if (input.scope === "skill" && !input.skillPath) {
    throw new Error("A skill-scoped takedown needs the skill's path in its repository.");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(takedowns)
      .values({
        scope: input.scope,
        sourceUrl: input.sourceUrl,
        skillPath: input.scope === "skill" ? (input.skillPath ?? null) : null,
        skillId: input.skillId ?? null,
        sourceId: input.sourceId ?? null,
        requester: input.requester,
        requesterEmail: input.requesterEmail ?? null,
        grounds: input.grounds,
        claim: input.claim,
        status: "received",
      })
      .returning({ id: takedowns.id });

    await tx.insert(events).values({
      actorType: "user",
      actorId,
      kind: "takedown.received",
      subjectType: "takedowns",
      subjectId: row.id,
      reason: `${input.grounds} — ${input.requester}`,
      payload: {
        scope: input.scope,
        sourceUrl: input.sourceUrl,
        skillPath: input.skillPath ?? null,
      },
    });

    return row.id;
  });
}

export type UpholdResult = {
  affectedSkills: number;
  bundlesDeleted: number;
  /** Bundles left in place because another, non-withdrawn version shares the same bytes. */
  bundlesShared: number;
  sourceDisabled: boolean;
};

/**
 * Honours a request: content out of storage, skills unserved, path blocked from returning.
 *
 * The order matters and is the opposite of the intuitive one. Postgres first, R2 second.
 * Nothing is served from R2 without a row saying it may be, so flipping the database first
 * makes the content unreachable immediately; deleting bytes first would leave a window
 * where the objects are gone and the app still believes it can serve them, which reads to a
 * user as a broken download rather than a withdrawal. If the R2 delete then fails, the
 * content is already unserved and `contentDeleted` honestly says the bytes are still there.
 */
export async function upholdTakedown(id: string, note?: string): Promise<UpholdResult> {
  const actor = await admin();
  return applyUphold(id, actor.userId, note);
}

async function applyUphold(
  id: string,
  actorId: string,
  note?: string,
): Promise<UpholdResult> {
  const [takedown] = await db.select().from(takedowns).where(eq(takedowns.id, id)).limit(1);
  if (!takedown) throw new Error("Takedown not found");
  if (takedown.status === "upheld") throw new Error("This takedown is already upheld.");

  /**
   * Which versions the decision covers.
   *
   * Resolved through `(source url, path)` rather than through `skillId`, because that is
   * the identity the ingest pipeline uses and the one the block will be enforced on. Going
   * through the id would withdraw exactly the row a curator was looking at and leave a
   * second row for the same upstream file — which is precisely the shape a re-sync creates.
   */
  const targets = await db
    .select({
      versionId: skillVersions.id,
      skillId: skillVersions.skillId,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
    })
    .from(skillVersions)
    .innerJoin(sources, eq(sources.id, skillVersions.sourceId))
    .where(
      and(
        sameRepoUrl(sources.url, takedown.sourceUrl),
        takedown.scope === "skill"
          ? sql`${skillVersions.provenance}->>'path' = ${takedown.skillPath}`
          : sql`true`,
      ),
    );

  const versionIds = targets.map((t) => t.versionId);
  const skillIds = [...new Set(targets.map((t) => t.skillId))];

  await db.transaction(async (tx) => {
    if (versionIds.length > 0) {
      await tx
        .update(skillVersions)
        .set({ status: "withdrawn", contentStored: false, storageKey: null })
        .where(inArray(skillVersions.id, versionIds));

      await tx
        .update(skills)
        .set({ status: "withdrawn", currentVersionId: null, updatedAt: new Date() })
        .where(inArray(skills.id, skillIds));
    }

    /**
     * A source-scoped takedown disables the source as well.
     *
     * Blocking every path individually would work until the repository added a file. The
     * request was about the repository, so the answer has to be about the repository —
     * and `pendingSources` already skips a disabled source, so the scheduler stops asking.
     */
    if (takedown.scope === "source") {
      await tx
        .update(sources)
        .set({
          enabled: false,
          health: "paused",
          healthDetail: `withdrawn on request (takedown ${id.slice(0, 8)})`,
          updatedAt: new Date(),
        })
        .where(sameRepoUrl(sources.url, takedown.sourceUrl));
    }

    await tx
      .update(takedowns)
      .set({
        status: "upheld",
        decidedBy: actorId,
        decidedAt: new Date(),
        decisionNote: note ?? null,
        affectedSkills: skillIds.length,
        updatedAt: new Date(),
      })
      .where(eq(takedowns.id, id));

    await tx.insert(events).values({
      actorType: "user",
      actorId,
      kind: "takedown.upheld",
      subjectType: "takedowns",
      subjectId: id,
      reason: note ?? `${takedown.grounds} — content withdrawn`,
      payload: {
        scope: takedown.scope,
        sourceUrl: takedown.sourceUrl,
        skillPath: takedown.skillPath,
        skills: skillIds.length,
        versions: versionIds.length,
      },
    });
  });

  const { deleted, shared } = await deleteStoredBundles(targets, versionIds);

  await db
    .update(takedowns)
    .set({ contentDeleted: deleted > 0 || targets.every((t) => !t.contentStored), updatedAt: new Date() })
    .where(eq(takedowns.id, id));

  return {
    affectedSkills: skillIds.length,
    bundlesDeleted: deleted,
    bundlesShared: shared,
    sourceDisabled: takedown.scope === "source",
  };
}

/**
 * Removes the objects, unless another stored version is standing on them.
 *
 * Storage is content-addressed — `public/sha256/<hash>/…` — so byte-identical skills share
 * **one** key. Deleting on a takedown without checking would break an unrelated
 * repository's download, and it would look like storage corruption rather than a takedown,
 * because nothing on the surface connects the two.
 *
 * The honest status of this check: it cannot currently fire. `skill_versions` carries a
 * unique index on `content_hash`, so two live versions cannot share one. But that index is
 * **partial** — `tombstoned` and `withdrawn` both escape it — and "no two rows share a
 * hash" is therefore not an invariant, only a consequence of two other statuses also
 * clearing `contentStored`. That is three conditions holding at once, in three different
 * files, guarding an irreversible delete. The check costs one query and is kept.
 */
async function deleteStoredBundles(
  targets: Array<{ versionId: string; contentHash: string; contentStored: boolean }>,
  withdrawnVersionIds: string[],
): Promise<{ deleted: number; shared: number }> {
  const hashes = [...new Set(targets.filter((t) => t.contentStored).map((t) => t.contentHash))];
  if (hashes.length === 0) return { deleted: 0, shared: 0 };

  const stillUsed = await db
    .select({ contentHash: skillVersions.contentHash })
    .from(skillVersions)
    .where(
      and(
        inArray(skillVersions.contentHash, hashes),
        eq(skillVersions.contentStored, true),
        withdrawnVersionIds.length > 0
          ? sql`${skillVersions.id} <> all(${withdrawnVersionIds})`
          : sql`true`,
      ),
    );
  const keep = new Set(stillUsed.map((row) => row.contentHash));

  let deleted = 0;
  for (const hash of hashes) {
    if (keep.has(hash)) continue;
    await deleteBundle("public", hash);
    deleted += 1;
  }
  return { deleted, shared: hashes.length - deleted };
}

/** Reviewed and refused. Nothing is withdrawn; the record of the claim stays. */
export async function rejectTakedown(id: string, note: string): Promise<void> {
  const actor = await admin();
  return applyReject(id, actor.userId, note);
}

async function applyReject(id: string, actorId: string, note: string): Promise<void> {
  if (!note.trim()) throw new Error("A rejection needs a reason.");

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(takedowns).where(eq(takedowns.id, id)).limit(1);
    if (!row) throw new Error("Takedown not found");
    if (row.status === "upheld") {
      throw new Error("This takedown was upheld — reinstate it instead of rejecting it.");
    }

    await tx
      .update(takedowns)
      .set({
        status: "rejected",
        decidedBy: actorId,
        decidedAt: new Date(),
        decisionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(takedowns.id, id));

    await tx.insert(events).values({
      actorType: "user",
      actorId,
      kind: "takedown.rejected",
      subjectType: "takedowns",
      subjectId: id,
      reason: note,
      payload: { scope: row.scope, sourceUrl: row.sourceUrl, skillPath: row.skillPath },
    });
  });
}

export type ReinstateResult = { unblocked: number; sourceReEnabled: boolean };

/**
 * Lifts an upheld takedown — a retraction, or a counter-notice that stood up.
 *
 * **The content does not come back here, and saying so is the point.** The bytes were
 * deleted from storage; this restores the *metadata* and removes the block, and the next
 * sync re-fetches the file and puts it back through validation like anything else. A
 * function that claimed to restore content would be lying about R2, and one that quietly
 * flipped the version to `indexed` would leave a skill that lists as servable and 409s on
 * download.
 *
 * `tombstoned` is the correct resting state: content withdrawn, metadata retained. It is
 * also what makes the return automatic, because a tombstoned skill whose file exists
 * upstream is exactly the case the sync path already handles.
 */
export async function reinstateTakedown(id: string, note: string): Promise<ReinstateResult> {
  const actor = await admin();
  return applyReinstate(id, actor.userId, note);
}

async function applyReinstate(
  id: string,
  actorId: string,
  note: string,
): Promise<ReinstateResult> {
  if (!note.trim()) throw new Error("Reinstating needs a reason — a retraction or a counter-notice.");

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(takedowns).where(eq(takedowns.id, id)).limit(1);
    if (!row) throw new Error("Takedown not found");
    if (row.status !== "upheld") throw new Error("Only an upheld takedown can be reinstated.");

    const withdrawn = await tx
      .select({ versionId: skillVersions.id, skillId: skillVersions.skillId })
      .from(skillVersions)
      .innerJoin(sources, eq(sources.id, skillVersions.sourceId))
      .where(
        and(
          eq(skillVersions.status, "withdrawn"),
          sameRepoUrl(sources.url, row.sourceUrl),
          row.scope === "skill"
            ? sql`${skillVersions.provenance}->>'path' = ${row.skillPath}`
            : sql`true`,
        ),
      );

    if (withdrawn.length > 0) {
      await tx
        .update(skillVersions)
        .set({ status: "tombstoned" })
        .where(inArray(skillVersions.id, withdrawn.map((w) => w.versionId)));

      await tx
        .update(skills)
        .set({ status: "tombstoned", updatedAt: new Date() })
        .where(inArray(skills.id, [...new Set(withdrawn.map((w) => w.skillId))]));
    }

    if (row.scope === "source") {
      await tx
        .update(sources)
        .set({ enabled: true, health: "unknown", healthDetail: null, updatedAt: new Date() })
        .where(sameRepoUrl(sources.url, row.sourceUrl));
    }

    await tx
      .update(takedowns)
      .set({
        status: "reinstated",
        decidedBy: actorId,
        decidedAt: new Date(),
        decisionNote: note,
        updatedAt: new Date(),
      })
      .where(eq(takedowns.id, id));

    await tx.insert(events).values({
      actorType: "user",
      actorId,
      kind: "takedown.reinstated",
      subjectType: "takedowns",
      subjectId: id,
      reason: note,
      payload: { scope: row.scope, sourceUrl: row.sourceUrl, skills: withdrawn.length },
    });

    return {
      unblocked: withdrawn.length,
      sourceReEnabled: row.scope === "source",
    };
  });
}

export type SourceBlocks = {
  /** The whole repository is withdrawn; do not enumerate or fetch anything. */
  sourceBlocked: boolean;
  /** Paths inside the repository that must not be fetched. */
  paths: ReadonlySet<string>;
};

/**
 * What is blocked in this repository, read before a single byte is fetched.
 *
 * No `requireAdmin`, no session, and that is deliberate: this runs inside `syncSource`,
 * which is background work with no org to declare. A block that only held for logged-in
 * requests would not be a block.
 *
 * Only `upheld` rows enforce. A `received` notice has been logged and not yet judged, and
 * enforcing on arrival would mean anyone who can send an email can un-list a competitor's
 * skill — which is the failure mode every takedown regime is criticised for.
 */
export async function activeBlocks(sourceUrl: string): Promise<SourceBlocks> {
  const rows = await db
    .select({ scope: takedowns.scope, skillPath: takedowns.skillPath })
    .from(takedowns)
    .where(and(eq(takedowns.sourceUrl, sourceUrl), inArray(takedowns.status, ENFORCING)));

  return {
    sourceBlocked: rows.some((row) => row.scope === "source"),
    paths: new Set(
      rows.filter((row) => row.scope === "skill" && row.skillPath).map((row) => row.skillPath!),
    ),
  };
}

export type TakedownRow = {
  id: string;
  scope: string;
  status: string;
  grounds: string;
  sourceUrl: string;
  skillPath: string | null;
  requester: string;
  claim: string;
  receivedAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  contentDeleted: boolean;
  affectedSkills: number;
  skillSlug: string | null;
  skillName: string | null;
};

/** The admin queue: undecided first, because those are the ones with a clock on them. */
export async function listTakedowns(query: PageQuery = {}): Promise<Paged<TakedownRow>> {
  await admin();

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(takedowns);

  const window = pageWindow(total, query.page, query.pageSize);

  const items = await db
    .select({
      id: takedowns.id,
      scope: takedowns.scope,
      status: takedowns.status,
      grounds: takedowns.grounds,
      sourceUrl: takedowns.sourceUrl,
      skillPath: takedowns.skillPath,
      requester: takedowns.requester,
      claim: takedowns.claim,
      receivedAt: takedowns.receivedAt,
      decidedAt: takedowns.decidedAt,
      decisionNote: takedowns.decisionNote,
      contentDeleted: takedowns.contentDeleted,
      affectedSkills: takedowns.affectedSkills,
      skillSlug: skills.slug,
      skillName: skills.name,
    })
    .from(takedowns)
    .leftJoin(skills, eq(skills.id, takedowns.skillId))
    .orderBy(
      sql`case when ${takedowns.status} = 'received' then 0 else 1 end`,
      desc(takedowns.receivedAt),
    )
    .limit(window.pageSize)
    .offset(window.offset);

  return { items, total, page: window.page, pageSize: window.pageSize, pageCount: window.pageCount };
}

export async function takedownCounts() {
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${takedowns.status} = 'received')::int`,
      upheld: sql<number>`count(*) filter (where ${takedowns.status} = 'upheld')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(takedowns);
  return row ?? { open: 0, upheld: 0, total: 0 };
}

/**
 * What a visitor may be told about a withdrawal.
 *
 * Grounds and date. **Never the requester**, and never the claim text. Publishing who asked
 * would turn a compliance record into a naming surface and chill exactly the author requests
 * Doc 1 promises to honour; publishing the claim would republish an allegation about a third
 * party that we have not adjudicated.
 *
 * Saying *something* still matters. R8.4 wants permalinks to keep resolving so a cited
 * verdict stays citable, and a page that silently 404s teaches a reader nothing about
 * whether the skill was dangerous, deleted, or withdrawn.
 */
export async function withdrawalNotice(
  skillId: string,
): Promise<{ grounds: string; decidedAt: Date | null } | null> {
  const [row] = await db
    .select({ grounds: takedowns.grounds, decidedAt: takedowns.decidedAt })
    .from(takedowns)
    .where(and(eq(takedowns.skillId, skillId), eq(takedowns.status, "upheld")))
    .orderBy(desc(takedowns.decidedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Test seams for `verify-takedown.mts`, matching `tombstoneForTest` in the ingest module.
 *
 * What they skip is the `requireAdmin()` call and nothing else — the enforcement itself is
 * the same function the server actions reach. A verification script that re-implemented
 * the withdrawal would prove that the script works, which is not the property in question:
 * `requireAdmin` reaches `next/navigation`, which cannot load in a plain node process, and
 * that is the only reason these exist.
 */
export const recordForTest = (input: TakedownInput, actorId: string) =>
  applyRecord(input, actorId);
export const upholdForTest = (id: string, actorId: string, note?: string) =>
  applyUphold(id, actorId, note);
export const rejectForTest = (id: string, actorId: string, note: string) =>
  applyReject(id, actorId, note);
export const reinstateForTest = (id: string, actorId: string, note: string) =>
  applyReinstate(id, actorId, note);
