import "server-only";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { isBlockType } from "@/lib/block-types";
import {
  MAX_SHARED_NAME,
  MAX_SHARED_TEXT,
  transclusionState,
  type SharedBlock,
  type SharedBlockRefusal,
  type TransclusionState,
} from "@/lib/shared-blocks";
import { getDraftBlocks, setDraftBlocks } from "@/server/builder/blocks";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { draftBlocks, events, sharedBlocks, skillDrafts } from "@/server/db/schema";

/**
 * Organisation convention blocks (Doc 6 RK.4, plan step E6) — Team.
 *
 * The reasoning is in `src/lib/shared-blocks.ts`; the one sentence worth repeating here is that a
 * transclusion is **synced, not substituted**. A shared block that changed does not rewrite forty
 * drafts — it marks them behind, and each author takes the update through the same block writer
 * every other change goes through, landing in their revision history with its own reason.
 *
 * Everything here is org-scoped with no public branch, because there is no such thing as a public
 * convention (RC.5).
 */

export type SharedResult<T> = { ok: true; data: T } | { ok: false; refusal: SharedBlockRefusal };

/** Every convention in the workspace, with how many drafts lean on it. */
export async function listSharedBlocks(
  orgId: string,
  options: { includeRetired?: boolean } = {},
): Promise<SharedBlock[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: sharedBlocks.id,
        name: sharedBlocks.name,
        type: sharedBlocks.type,
        text: sharedBlocks.text,
        note: sharedBlocks.note,
        version: sharedBlocks.version,
        retiredAt: sharedBlocks.retiredAt,
        /*
         * Distinct *drafts*, not blocks. A draft that pulled the same convention into two
         * sections is one dependent, and counting rows would tell an admin about to edit it that
         * twice as much work depends on the change as really does.
         */
        usedByDrafts: sql<number>`(
          select count(distinct b.draft_id)::int from draft_blocks b
           where b.shared_block_id = ${sharedBlocks.id}
        )`,
      })
      .from(sharedBlocks)
      .where(options.includeRetired ? undefined : isNull(sharedBlocks.retiredAt))
      .orderBy(asc(sharedBlocks.name));
    return rows;
  });
}

export async function createSharedBlock(input: {
  orgId: string;
  userId: string;
  name: string;
  type: string;
  text: string;
  note?: string | null;
}): Promise<SharedResult<{ id: string }>> {
  const name = input.name.trim().slice(0, MAX_SHARED_NAME);
  const text = input.text.trim();
  if (!name || !text) return { ok: false, refusal: "empty" };
  if (text.length > MAX_SHARED_TEXT) return { ok: false, refusal: "too-long" };
  /*
   * A typed convention or none at all. An untyped shared block cannot be compared against an
   * archetype's grammar, which is most of what makes sharing it worth doing — and `block-types.ts`
   * keeps `null` valid for an *author's* prose precisely because a workbench must not refuse to
   * hold a paragraph. A convention is not that; somebody chose to publish it.
   */
  if (!isBlockType(input.type)) return { ok: false, refusal: "untyped" };

  return withExplicitOrgScope(input.orgId, async (tx) => {
    const [clash] = await tx
      .select({ id: sharedBlocks.id })
      .from(sharedBlocks)
      .where(sql`lower(${sharedBlocks.name}) = lower(${name})`)
      .limit(1);
    if (clash) return { ok: false as const, refusal: "duplicate-name" as const };

    const [row] = await tx
      .insert(sharedBlocks)
      .values({
        orgId: input.orgId,
        name,
        type: input.type,
        text,
        note: input.note?.trim() || null,
        createdBy: input.userId,
      })
      .returning({ id: sharedBlocks.id });

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "shared-block.created",
      subjectType: "shared_blocks",
      subjectId: row.id,
      payload: { name, type: input.type },
    });

    return { ok: true as const, data: { id: row.id } };
  });
}

/**
 * Edit a convention. Bumps the version, which is what puts every dependent behind.
 *
 * Nothing else happens: no draft is touched, no body is rewritten, no revision is written to
 * anybody's history. The edit makes an *offer* to forty authors, and `syncDraftTransclusions` is
 * how one of them accepts it.
 */
export async function updateSharedBlock(input: {
  orgId: string;
  userId: string;
  id: string;
  text: string;
  note?: string | null;
}): Promise<SharedResult<{ version: number; dependents: number }>> {
  const text = input.text.trim();
  if (!text) return { ok: false, refusal: "empty" };
  if (text.length > MAX_SHARED_TEXT) return { ok: false, refusal: "too-long" };

  return withExplicitOrgScope(input.orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: sharedBlocks.id, version: sharedBlocks.version, text: sharedBlocks.text, name: sharedBlocks.name })
      .from(sharedBlocks)
      .where(eq(sharedBlocks.id, input.id))
      .limit(1);
    if (!existing) return { ok: false as const, refusal: "not-found" as const };

    /*
     * A no-op edit does not bump the version.
     *
     * Otherwise saving the form without changing anything would put every dependent behind and
     * ask forty people to review a change nobody made — the fastest way to teach them to ignore
     * the notice.
     */
    const changed = existing.text !== text;
    const version = changed ? existing.version + 1 : existing.version;

    await tx
      .update(sharedBlocks)
      .set({ text, note: input.note?.trim() || null, version, updatedAt: new Date() })
      .where(eq(sharedBlocks.id, input.id));

    const [{ dependents }] = await tx
      .select({ dependents: sql<number>`count(distinct ${draftBlocks.draftId})::int` })
      .from(draftBlocks)
      .where(eq(draftBlocks.sharedBlockId, input.id));

    if (changed) {
      await tx.insert(events).values({
        orgId: input.orgId,
        actorType: "user",
        actorId: input.userId,
        kind: "shared-block.updated",
        subjectType: "shared_blocks",
        subjectId: input.id,
        payload: { name: existing.name, version, dependents },
      });
    }

    return { ok: true as const, data: { version, dependents } };
  });
}

/**
 * Retire a convention. The row and every dependent's copy stay exactly as they are.
 *
 * Deleting would null forty pointers and leave forty authors with a block that silently stopped
 * tracking anything and no way to find out why. Same call as a withdrawn maintainer standing.
 */
export async function retireSharedBlock(input: {
  orgId: string;
  userId: string;
  id: string;
}): Promise<SharedResult<{ dependents: number }>> {
  return withExplicitOrgScope(input.orgId, async (tx) => {
    const updated = await tx
      .update(sharedBlocks)
      .set({ retiredAt: new Date() })
      .where(and(eq(sharedBlocks.id, input.id), isNull(sharedBlocks.retiredAt)))
      .returning({ id: sharedBlocks.id, name: sharedBlocks.name });
    if (updated.length === 0) return { ok: false as const, refusal: "not-found" as const };

    const [{ dependents }] = await tx
      .select({ dependents: sql<number>`count(distinct ${draftBlocks.draftId})::int` })
      .from(draftBlocks)
      .where(eq(draftBlocks.sharedBlockId, input.id));

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "shared-block.retired",
      subjectType: "shared_blocks",
      subjectId: input.id,
      payload: { name: updated[0].name, dependents },
    });

    return { ok: true as const, data: { dependents } };
  });
}

/**
 * Pull a convention into a draft, at the end.
 *
 * Appended rather than placed, for the reason `decideCandidate` gives: the archetype's typical
 * position is a median over a corpus and not a statement about this document. It goes through
 * `setDraftBlocks`, so the body stays a render of the blocks and the addition is in the history.
 */
export async function transcludeSharedBlock(input: {
  orgId: string;
  userId: string;
  draftId: string;
  sharedBlockId: string;
}): Promise<SharedResult<{ blockId: string | null }>> {
  const shared = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(sharedBlocks)
      .where(eq(sharedBlocks.id, input.sharedBlockId))
      .limit(1);
    return row ?? null;
  });
  if (!shared) return { ok: false, refusal: "not-found" };
  if (shared.retiredAt) return { ok: false, refusal: "retired" };
  if (!isBlockType(shared.type)) return { ok: false, refusal: "untyped" };

  const existing = await getDraftBlocks(input.draftId, input.orgId);
  const result = await setDraftBlocks(
    input.draftId,
    input.orgId,
    [
      ...existing.map((block) => ({
        id: block.id,
        form: block.form,
        depth: block.depth,
        type: block.type,
        text: block.text,
        sharedBlockId: block.sharedBlockId ?? null,
        sharedBlockVersion: block.sharedBlockVersion ?? null,
      })),
      {
        form: "content" as const,
        depth: null,
        type: shared.type,
        text: shared.text,
        sharedBlockId: shared.id,
        sharedBlockVersion: shared.version,
      },
    ],
    { reason: "shared", note: shared.name, createdBy: input.userId },
  );

  return { ok: true, data: { blockId: result.blocks[result.blocks.length - 1]?.id ?? null } };
}

export type TransclusionRow = {
  blockId: string;
  sharedBlockId: string;
  name: string;
  state: TransclusionState;
  /** What the convention says now. Only differs from the block when the state is `behind`. */
  currentText: string;
};

/** What a draft's transclusions look like right now. Derived on read, never stored. */
export async function draftTransclusions(
  draftId: string,
  orgId: string,
): Promise<TransclusionRow[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        blockId: draftBlocks.id,
        blockVersion: draftBlocks.sharedBlockVersion,
        sharedBlockId: sharedBlocks.id,
        name: sharedBlocks.name,
        version: sharedBlocks.version,
        text: sharedBlocks.text,
        retiredAt: sharedBlocks.retiredAt,
      })
      .from(draftBlocks)
      .innerJoin(sharedBlocks, eq(sharedBlocks.id, draftBlocks.sharedBlockId))
      .where(eq(draftBlocks.draftId, draftId))
      .orderBy(asc(draftBlocks.blockOrder));

    return rows.map((row) => ({
      blockId: row.blockId,
      sharedBlockId: row.sharedBlockId,
      name: row.name,
      state: transclusionState({
        sharedVersion: row.version,
        blockVersion: row.blockVersion,
        retired: row.retiredAt !== null,
      }),
      currentText: row.text,
    }));
  });
}

/**
 * Take the pending updates. One write, through the one writer, into the revision history.
 *
 * All of a draft's behind-blocks at once rather than one at a time: an author who has decided to
 * adopt the new conventions has decided once, and four separate revisions of one decision makes
 * the history harder to read rather than more precise.
 */
export async function syncDraftTransclusions(input: {
  orgId: string;
  userId: string;
  draftId: string;
}): Promise<{ ok: boolean; updated: number }> {
  const [blocks, transclusions] = await Promise.all([
    getDraftBlocks(input.draftId, input.orgId),
    draftTransclusions(input.draftId, input.orgId),
  ]);

  const behind = new Map(
    transclusions.filter((row) => row.state === "behind").map((row) => [row.blockId, row]),
  );
  if (behind.size === 0) return { ok: true, updated: 0 };

  const current = await withExplicitOrgScope(input.orgId, async (tx) =>
    tx
      .select({ id: sharedBlocks.id, version: sharedBlocks.version })
      .from(sharedBlocks)
      .where(isNull(sharedBlocks.retiredAt)),
  );
  const versionOf = new Map(current.map((row) => [row.id, row.version]));

  await setDraftBlocks(
    input.draftId,
    input.orgId,
    blocks.map((block) => {
      const update = behind.get(block.id);
      return {
        id: block.id,
        form: block.form,
        depth: block.depth,
        type: block.type,
        text: update ? update.currentText : block.text,
        sharedBlockId: block.sharedBlockId ?? null,
        sharedBlockVersion: update
          ? (versionOf.get(update.sharedBlockId) ?? block.sharedBlockVersion ?? null)
          : (block.sharedBlockVersion ?? null),
      };
    }),
    {
      reason: "shared",
      note: `${behind.size} convention${behind.size === 1 ? "" : "s"} updated`,
      createdBy: input.userId,
    },
  );

  return { ok: true, updated: behind.size };
}

/**
 * RK.4's *"dependent-skill re-validation"*, as a list rather than an action.
 *
 * A published skill is bytes at a content hash a verdict covers, so re-resolving a transclusion
 * into it would change what the verdict describes while the verdict went on claiming to describe
 * it. What this answers instead is *which published skills came from drafts that are now behind* —
 * and re-publishing stays the author's deliberate act.
 */
export async function staleDependents(orgId: string) {
  return withExplicitOrgScope(orgId, async (tx) =>
    tx
      .select({
        draftId: skillDrafts.id,
        draftName: skillDrafts.name,
        publishedSkillId: skillDrafts.publishedSkillId,
        conventions: sql<number>`count(distinct ${sharedBlocks.id})::int`,
      })
      .from(draftBlocks)
      .innerJoin(sharedBlocks, eq(sharedBlocks.id, draftBlocks.sharedBlockId))
      .innerJoin(skillDrafts, eq(skillDrafts.id, draftBlocks.draftId))
      .where(sql`${draftBlocks.sharedBlockVersion} < ${sharedBlocks.version}`)
      .groupBy(skillDrafts.id, skillDrafts.name, skillDrafts.publishedSkillId)
      .orderBy(desc(sql`count(distinct ${sharedBlocks.id})`)),
  );
}
