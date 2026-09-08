import "server-only";

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";

import {
  MAX_ENDORSEMENT_NOTE,
  MAX_MAINTAINER_NOTE,
  type EndorseRefusal,
  type Endorsement,
  type EndorsementView,
  type Maintainer,
  type MaintainerAxis,
} from "@/lib/maintainers";
import { db } from "@/server/db";
import {
  categoryMaintainers,
  events,
  member,
  skillCategories,
  skillEndorsements,
  skills,
  user,
} from "@/server/db/schema";
import {
  isValidCategory,
  labelFor,
  REVIEW_FLOOR,
  type CategoryAxis,
} from "@/server/taxonomy/vocabulary";

/**
 * Maintainer groups, earned curation rights and endorsement (Doc 6 RK.6, plan step E5).
 *
 * ## Three things, and the middle one is the point
 *
 * 1. **Appointment** — an admin names somebody a maintainer of a category. Revocable, kept.
 * 2. **Earned curation rights** — a maintainer may decide a flag on a skill in one of their own
 *    categories. That is the half RK.6 means by *communities of practice, applied*: until now
 *    every reader report in the corpus went to one queue that one admin worked, which does not
 *    scale and, more importantly, sends a legal-review report to whoever happens to be on duty
 *    rather than to somebody who can read it.
 * 3. **Endorsement** — a maintainer's name on a skill, as a social signal beside the verdicts.
 *
 * ## Eligibility is always the same question, asked once
 *
 * `maintainerCategoriesFor` answers *which of this skill's categories does this person maintain
 * right now*, and both the curation right and the endorsement are decided by whether that list
 * is empty. One function, so the badge on a page and the permission behind a POST cannot come to
 * different conclusions — the same reason `lifecycleExpression()` is the only place a lifecycle
 * state is computed.
 *
 * ## The categories a skill counts as are the ones the registry serves
 *
 * `confidence >= REVIEW_FLOOR or reviewed_at is not null`, which is the rule `listSkills` and the
 * archetype miner both apply. A held assignment is one the classifier itself flagged as
 * unreliable, and granting curation rights over a skill on the strength of a guess would hand
 * somebody authority over a document that is not really in their category.
 */

/** Membership rows for a person, live only. Revoked standing authorises nothing. */
export async function liveMaintainerships(userId: string): Promise<
  Array<{ axis: MaintainerAxis; category: string }>
> {
  const rows = await db
    .select({ axis: categoryMaintainers.axis, category: categoryMaintainers.category })
    .from(categoryMaintainers)
    .where(
      and(eq(categoryMaintainers.userId, userId), isNull(categoryMaintainers.revokedAt)),
    );
  return rows.map((row) => ({ axis: row.axis as MaintainerAxis, category: row.category }));
}

/** The servable categories of one skill, both axes. */
export async function servableCategories(
  skillId: string,
): Promise<Array<{ axis: MaintainerAxis; value: string }>> {
  const rows = await db
    .select({ axis: skillCategories.axis, value: skillCategories.value })
    .from(skillCategories)
    .where(
      and(
        eq(skillCategories.skillId, skillId),
        or(
          sql`${skillCategories.confidence} >= ${REVIEW_FLOOR}`,
          sql`${skillCategories.reviewedAt} is not null`,
        ),
      ),
    );
  return rows.map((row) => ({ axis: row.axis as MaintainerAxis, value: row.value }));
}

/**
 * The intersection: which of this skill's categories does this person maintain.
 *
 * Empty means not eligible, for either operation. Non-empty is also *what they are speaking as*,
 * which is what gets stored on an endorsement.
 */
export async function maintainerCategoriesFor(
  userId: string,
  skillId: string,
): Promise<Array<{ axis: MaintainerAxis; category: string }>> {
  const [held, categories] = await Promise.all([
    liveMaintainerships(userId),
    servableCategories(skillId),
  ]);
  const owned = new Set(categories.map((c) => `${c.axis}:${c.value}`));
  return held.filter((h) => owned.has(`${h.axis}:${h.category}`));
}

/**
 * May this person decide a flag on this skill?
 *
 * Admin is decided by the caller — this answers the *earned* half only, so the two authorities
 * stay separable and an admin losing the role does not silently take the maintainer's rights with
 * it.
 */
export async function canCurate(userId: string, skillId: string): Promise<boolean> {
  return (await maintainerCategoriesFor(userId, skillId)).length > 0;
}

export type GrantResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Appoint a maintainer.
 *
 * Admin-only, enforced by the caller. Re-granting a lapsed standing clears `revoked_at` on the
 * existing row rather than writing a second one — see the unique index's note: two rows for one
 * pair would leave every read choosing between them.
 */
export async function grantMaintainer(input: {
  /** By email, because that is what an admin has. Resolved to an id before anything is written. */
  email: string;
  axis: string;
  category: string;
  note?: string | null;
  actorId: string;
}): Promise<GrantResult> {
  if (input.axis !== "function" && input.axis !== "domain") {
    return { ok: false, message: "Axis must be function or domain." };
  }
  if (!isValidCategory(input.axis as CategoryAxis, input.category)) {
    /*
     * Refused rather than stored, the same posture `setModel` takes on an unpriced model id: an
     * appointment to a category that does not exist can never match a skill, so it would sit in
     * the table looking like standing and authorising nothing — and the person who mistyped it is
     * the only one who could have caught it immediately.
     */
    return { ok: false, message: `No such ${input.axis} category: ${input.category}.` };
  }

  /*
   * Matched case-insensitively, because an email address is.
   *
   * The same lesson as the repository-identity fold: a case-sensitive `=` on data the outside
   * world treats as case-insensitive silently fails to find a row that is plainly there, and the
   * admin retyping it has no way to see why.
   */
  const [target] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${input.email.trim()})`)
    .limit(1);
  if (!target) return { ok: false, message: `No account with the email ${input.email.trim()}.` };

  await db.transaction(async (tx) => {
    await tx
      .insert(categoryMaintainers)
      .values({
        userId: target.id,
        axis: input.axis as CategoryAxis,
        category: input.category,
        note: input.note?.trim().slice(0, MAX_MAINTAINER_NOTE) || null,
        grantedBy: input.actorId,
      })
      .onConflictDoUpdate({
        target: [
          categoryMaintainers.userId,
          categoryMaintainers.axis,
          categoryMaintainers.category,
        ],
        set: {
          revokedAt: null,
          revokedBy: null,
          note: input.note?.trim().slice(0, MAX_MAINTAINER_NOTE) || null,
          grantedBy: input.actorId,
        },
      });

    await tx.insert(events).values({
      actorType: "user",
      actorId: input.actorId,
      kind: "maintainer.granted",
      subjectType: "user",
      subjectId: target.id,
      reason: input.note?.trim().slice(0, 300) || null,
      payload: { axis: input.axis, category: input.category },
    });
  });

  return {
    ok: true,
    message: `${target.name} maintains ${labelFor(input.axis as CategoryAxis, input.category)}.`,
  };
}

/**
 * Withdraw standing. The row stays.
 *
 * Every endorsement that person made stops counting on the next page load, because endorsements
 * resolve live against this table — no sweep, nothing to remember. Their past decisions stay in
 * the audit log and stay readable, which is why the row is not deleted.
 */
export async function revokeMaintainer(input: {
  userId: string;
  axis: string;
  category: string;
  actorId: string;
}): Promise<GrantResult> {
  const updated = await db
    .update(categoryMaintainers)
    .set({ revokedAt: new Date(), revokedBy: input.actorId })
    .where(
      and(
        eq(categoryMaintainers.userId, input.userId),
        eq(categoryMaintainers.axis, input.axis as CategoryAxis),
        eq(categoryMaintainers.category, input.category),
        isNull(categoryMaintainers.revokedAt),
      ),
    )
    .returning({ id: categoryMaintainers.id });

  if (updated.length === 0) return { ok: false, message: "No live standing to revoke." };

  await db.insert(events).values({
    actorType: "user",
    actorId: input.actorId,
    kind: "maintainer.revoked",
    subjectType: "user",
    subjectId: input.userId,
    payload: { axis: input.axis, category: input.category },
  });

  return { ok: true, message: "Standing withdrawn. Their endorsements stop counting." };
}

/** Every appointment, live first. Admin panel and CLI. */
export async function listMaintainers(
  options: { includeRevoked?: boolean } = {},
): Promise<Maintainer[]> {
  const rows = await db
    .select({
      userId: categoryMaintainers.userId,
      name: user.name,
      axis: categoryMaintainers.axis,
      category: categoryMaintainers.category,
      note: categoryMaintainers.note,
      since: categoryMaintainers.grantedAt,
      revokedAt: categoryMaintainers.revokedAt,
    })
    .from(categoryMaintainers)
    .innerJoin(user, eq(user.id, categoryMaintainers.userId))
    .where(options.includeRevoked ? undefined : isNull(categoryMaintainers.revokedAt))
    .orderBy(categoryMaintainers.axis, categoryMaintainers.category, desc(categoryMaintainers.grantedAt));

  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    axis: row.axis as MaintainerAxis,
    category: row.category,
    categoryLabel: labelFor(row.axis as CategoryAxis, row.category),
    note: row.note,
    since: row.since,
    revokedAt: row.revokedAt,
  }));
}

export type EndorseResult =
  | { ok: true; message: string }
  | { ok: false; refusal: EndorseRefusal };

/**
 * Endorse a skill.
 *
 * Every refusal is one of the four named reasons, so a caller renders the right sentence rather
 * than a generic failure. The order matters: the facts about the skill are checked before the
 * facts about the person, because "this skill cannot be endorsed" is true for everybody and
 * telling a maintainer they are not a maintainer would be wrong.
 */
export async function endorse(input: {
  slug: string;
  userId: string;
  note?: string | null;
}): Promise<EndorseResult> {
  const [skill] = await db
    .select({
      id: skills.id,
      orgId: skills.orgId,
      status: skills.status,
      versionId: skills.currentVersionId,
    })
    .from(skills)
    .where(eq(skills.slug, input.slug))
    .limit(1);

  if (!skill || skill.status !== "indexed") return { ok: false, refusal: "not-servable" };
  if (!skill.versionId) return { ok: false, refusal: "no-version" };

  /*
   * No endorsing your own workspace's work.
   *
   * The only ownership this platform can actually see is the org a skill was published from — a
   * mirrored corpus skill belongs to a stranger by construction, so there is nothing to check
   * there. Stated rather than implied, because "we verified the endorser is not the author" would
   * be a stronger claim than the data supports.
   */
  if (skill.orgId) {
    const [mine] = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, skill.orgId), eq(member.userId, input.userId)))
      .limit(1);
    if (mine) return { ok: false, refusal: "own-work" };
  }

  const standing = await maintainerCategoriesFor(input.userId, skill.id);
  if (standing.length === 0) return { ok: false, refusal: "not-a-maintainer" };

  /*
   * One standing is recorded even when they hold several.
   *
   * Function first, because that is the axis archetypes are mined on and the one a maintainer is
   * most likely to have been appointed for. Recording all of them would make one person's single
   * endorsement read as several claims.
   */
  const speaking = standing.find((s) => s.axis === "function") ?? standing[0];
  const note = input.note?.trim().slice(0, MAX_ENDORSEMENT_NOTE) || null;

  await db.transaction(async (tx) => {
    if (skill.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${skill.orgId}, true)`);
    }
    await tx
      .insert(skillEndorsements)
      .values({
        orgId: skill.orgId,
        skillId: skill.id,
        skillVersionId: skill.versionId!,
        userId: input.userId,
        axis: speaking.axis as CategoryAxis,
        category: speaking.category,
        note,
      })
      /*
       * Re-endorsing refreshes rather than duplicating: same person, same skill, new version or a
       * better sentence. It also un-withdraws, which is the only way back after a withdrawal and
       * is deliberate — the alternative is a row nobody can ever use again.
       */
      .onConflictDoUpdate({
        target: [skillEndorsements.skillId, skillEndorsements.userId],
        set: {
          skillVersionId: skill.versionId!,
          axis: speaking.axis as CategoryAxis,
          category: speaking.category,
          note,
          at: new Date(),
          withdrawnAt: null,
        },
      });

    await tx.insert(events).values({
      orgId: skill.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "skill.endorsed",
      subjectType: "skill",
      subjectId: skill.id,
      reason: note?.slice(0, 300) ?? null,
      payload: { axis: speaking.axis, category: speaking.category },
    });
  });

  return { ok: true, message: "Endorsed, under your name." };
}

/** Take an endorsement back. Hidden everywhere at once; the row and the audit trail stay. */
export async function withdrawEndorsement(input: {
  slug: string;
  userId: string;
}): Promise<{ ok: boolean; message: string }> {
  const [skill] = await db
    .select({ id: skills.id, orgId: skills.orgId })
    .from(skills)
    .where(eq(skills.slug, input.slug))
    .limit(1);
  if (!skill) return { ok: false, message: "No such skill." };

  const updated = await db.transaction(async (tx) => {
    if (skill.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${skill.orgId}, true)`);
    }
    const rows = await tx
      .update(skillEndorsements)
      .set({ withdrawnAt: new Date() })
      .where(
        and(
          eq(skillEndorsements.skillId, skill.id),
          eq(skillEndorsements.userId, input.userId),
          isNull(skillEndorsements.withdrawnAt),
        ),
      )
      .returning({ id: skillEndorsements.id });

    if (rows.length > 0) {
      await tx.insert(events).values({
        orgId: skill.orgId,
        actorType: "user",
        actorId: input.userId,
        kind: "skill.endorsement-withdrawn",
        subjectType: "skill",
        subjectId: skill.id,
      });
    }
    return rows.length;
  });

  return updated > 0
    ? { ok: true, message: "Withdrawn." }
    : { ok: false, message: "You have no live endorsement of this skill." };
}

/**
 * What a reader sees.
 *
 * Three facts, not one: who endorsed, how many people *could have*, and which of the skill's
 * categories have a maintainer group at all. An empty list on its own is unreadable — for most
 * of this corpus it means nobody was eligible, and printing it as "no endorsements" would be the
 * `archetypes --blocks` mistake: a confident zero that means "not measured".
 */
export async function endorsementsFor(skillId: string): Promise<EndorsementView> {
  const categories = await servableCategories(skillId);
  if (categories.length === 0) {
    return { endorsements: [], eligible: 0, coveredCategories: [] };
  }

  const pairs = sql.join(
    categories.map(
      (c) => sql`(${categoryMaintainers.axis} = ${c.axis} and ${categoryMaintainers.category} = ${c.value})`,
    ),
    sql` or `,
  );

  const [eligibleRows, endorsementRows] = await Promise.all([
    db
      .select({
        userId: categoryMaintainers.userId,
        axis: categoryMaintainers.axis,
        category: categoryMaintainers.category,
      })
      .from(categoryMaintainers)
      .where(and(isNull(categoryMaintainers.revokedAt), sql`(${pairs})`)),
    db
      .select({
        userId: skillEndorsements.userId,
        name: user.name,
        note: skillEndorsements.note,
        at: skillEndorsements.at,
        axis: skillEndorsements.axis,
        category: skillEndorsements.category,
        endorsedVersion: skillEndorsements.skillVersionId,
        currentVersion: skills.currentVersionId,
      })
      .from(skillEndorsements)
      .innerJoin(user, eq(user.id, skillEndorsements.userId))
      .innerJoin(skills, eq(skills.id, skillEndorsements.skillId))
      /*
       * The live join that makes the whole thing honest: an endorsement counts only while its
       * endorser still maintains the category they endorsed under. No stored copy of standing,
       * so revoking is instant everywhere and there is nothing to sweep.
       */
      .innerJoin(
        categoryMaintainers,
        and(
          eq(categoryMaintainers.userId, skillEndorsements.userId),
          eq(categoryMaintainers.axis, skillEndorsements.axis),
          eq(categoryMaintainers.category, skillEndorsements.category),
          isNull(categoryMaintainers.revokedAt),
        ),
      )
      .where(
        and(eq(skillEndorsements.skillId, skillId), isNull(skillEndorsements.withdrawnAt)),
      )
      .orderBy(desc(skillEndorsements.at)),
  ]);

  const covered = new Set(eligibleRows.map((row) => `${row.axis}:${row.category}`));
  const endorsements: Endorsement[] = endorsementRows.map((row) => ({
    userId: row.userId,
    name: row.name,
    note: row.note,
    at: row.at,
    axis: row.axis as MaintainerAxis,
    category: row.category,
    categoryLabel: labelFor(row.axis as CategoryAxis, row.category),
    stale: row.endorsedVersion !== row.currentVersion,
  }));

  return {
    endorsements,
    /* Distinct people, not rows: one person maintaining both axes is one possible endorsement. */
    eligible: new Set(eligibleRows.map((row) => row.userId)).size,
    coveredCategories: [...covered].map((key) => {
      const [axis, value] = key.split(":");
      return labelFor(axis as CategoryAxis, value);
    }),
  };
}

/** Counts for the settings tab and the CLI. */
export async function maintainerSummary() {
  const [maintainers] = await db
    .select({
      live: sql<number>`count(*) filter (where ${categoryMaintainers.revokedAt} is null)::int`,
      revoked: sql<number>`count(*) filter (where ${categoryMaintainers.revokedAt} is not null)::int`,
      people: sql<number>`count(distinct ${categoryMaintainers.userId}) filter (where ${categoryMaintainers.revokedAt} is null)::int`,
      /* Concatenated rather than `count(distinct (a, b))`, which Postgres reads as a record. */
      categories: sql<number>`count(distinct ${categoryMaintainers.axis}::text || ':' || ${categoryMaintainers.category}) filter (where ${categoryMaintainers.revokedAt} is null)::int`,
    })
    .from(categoryMaintainers);

  const [endorsements] = await db
    .select({
      live: sql<number>`count(*) filter (where ${skillEndorsements.withdrawnAt} is null)::int`,
      withdrawn: sql<number>`count(*) filter (where ${skillEndorsements.withdrawnAt} is not null)::int`,
      skills: sql<number>`count(distinct ${skillEndorsements.skillId}) filter (where ${skillEndorsements.withdrawnAt} is null)::int`,
    })
    .from(skillEndorsements);

  return {
    maintainers: maintainers ?? { live: 0, revoked: 0, people: 0, categories: 0 },
    endorsements: endorsements ?? { live: 0, withdrawn: 0, skills: 0 },
  };
}

/**
 * Skills carrying at least one live endorsement, newest first.
 *
 * Deliberately **not** a ranking surface. Endorsement counts are single digits over a corpus of
 * tens of thousands, so sorting the registry by them would put four skills above forty-nine
 * thousand on the strength of who happens to have a maintainer group. It is a list for the
 * settings panel and the CLI, so an operator can read what the group has actually done.
 */
export async function endorsedSkills(limit = 50) {
  const rows = await db
    .select({
      slug: skills.slug,
      name: skills.name,
      endorsements: sql<number>`count(*)::int`,
      latest: sql<Date>`max(${skillEndorsements.at})`,
    })
    .from(skillEndorsements)
    .innerJoin(skills, eq(skills.id, skillEndorsements.skillId))
    .innerJoin(
      categoryMaintainers,
      and(
        eq(categoryMaintainers.userId, skillEndorsements.userId),
        eq(categoryMaintainers.axis, skillEndorsements.axis),
        eq(categoryMaintainers.category, skillEndorsements.category),
        isNull(categoryMaintainers.revokedAt),
      ),
    )
    .where(isNull(skillEndorsements.withdrawnAt))
    .groupBy(skills.slug, skills.name)
    .orderBy(sql`max(${skillEndorsements.at}) desc`)
    .limit(limit);
  return rows;
}

/** The skills one maintainer could act on — used by the CLI to show a group its own scope. */
export async function scopeOf(userId: string) {
  const held = await liveMaintainerships(userId);
  if (held.length === 0) return { held, skills: 0 };

  /*
   * Matched on the pair, not on the value alone.
   *
   * `function` and `domain` are separate vocabularies with no guarantee of disjoint slugs, and a
   * value-only `in` would silently widen somebody's scope across the axis they were not appointed
   * to. The same class of bug as the case-sensitive curated-source lookup: a comparison that drops
   * half the key looks right and counts the wrong rows.
   */
  const pairs = sql.join(
    held.map(
      (h) => sql`(${skillCategories.axis} = ${h.axis} and ${skillCategories.value} = ${h.category})`,
    ),
    sql` or `,
  );
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${skillCategories.skillId})::int` })
    .from(skillCategories)
    .where(
      and(
        sql`(${pairs})`,
        or(
          sql`${skillCategories.confidence} >= ${REVIEW_FLOOR}`,
          sql`${skillCategories.reviewedAt} is not null`,
        ),
      ),
    );
  return { held, skills: row?.n ?? 0 };
}

/**
 * What the endorse control on a skill page should show.
 *
 * Resolved on the server and passed down, never inferred in the browser from a role: the same
 * posture the sidebar's admin flag takes. It answers three separate questions, because the
 * control has three states and collapsing any two of them produces a button that fails when
 * pressed — the failure the refusal vocabulary exists to make impossible.
 */
export async function endorseAffordance(
  userId: string | null,
  skillId: string,
): Promise<{ eligible: boolean; already: boolean }> {
  if (!userId) return { eligible: false, already: false };

  const [standing, mine] = await Promise.all([
    maintainerCategoriesFor(userId, skillId),
    db
      .select({ id: skillEndorsements.id })
      .from(skillEndorsements)
      .where(
        and(
          eq(skillEndorsements.skillId, skillId),
          eq(skillEndorsements.userId, userId),
          isNull(skillEndorsements.withdrawnAt),
        ),
      )
      .limit(1),
  ]);

  return { eligible: standing.length > 0, already: mine.length > 0 };
}

/** Everything one maintainer has endorsed, for their own page. Withdrawn rows excluded. */
export async function endorsementsBy(userId: string) {
  return db
    .select({
      slug: skills.slug,
      name: skills.name,
      note: skillEndorsements.note,
      at: skillEndorsements.at,
      axis: skillEndorsements.axis,
      category: skillEndorsements.category,
      stale: sql<boolean>`${skillEndorsements.skillVersionId} <> ${skills.currentVersionId}`,
    })
    .from(skillEndorsements)
    .innerJoin(skills, eq(skills.id, skillEndorsements.skillId))
    .where(and(eq(skillEndorsements.userId, userId), isNull(skillEndorsements.withdrawnAt)))
    .orderBy(desc(skillEndorsements.at))
    .limit(100);
}

/**
 * Does this person hold any live standing?
 *
 * One indexed row lookup, called once per protected render to decide whether the sidebar offers
 * the curation desk. Kept separate from `liveMaintainerships` so the layout does not pull a list
 * it will not render — the same reason the protected layout stopped resolving the organisation
 * once the workspace row was removed.
 */
export async function isMaintainer(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: categoryMaintainers.id })
    .from(categoryMaintainers)
    .where(and(eq(categoryMaintainers.userId, userId), isNull(categoryMaintainers.revokedAt)))
    .limit(1);
  return Boolean(row);
}
