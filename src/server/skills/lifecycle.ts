import "server-only";

import { eq, sql, type SQL } from "drizzle-orm";

import {
  isLifecycleDeclaration,
  type LifecycleDeclaration,
  type LifecycleState,
} from "@/lib/lifecycle";
import { db } from "@/server/db";
import { events, skills } from "@/server/db/schema";

/**
 * Deriving and declaring a skill's lifecycle (Doc 6 RK.1).
 *
 * ## One derivation, in SQL, and nowhere else
 *
 * `lifecycleExpression()` is the **only** place the state is computed. Not a TypeScript
 * helper with a SQL twin, which is the shape this codebase has been bitten by twice: a
 * status command reporting thirteen archetype-ready categories while the miner refused one
 * of them, and a near-proxy replacement for it that agreed to within a point and would have
 * turned a visible contradiction into an invisible one. A lifecycle badge on a skill page
 * and a lifecycle filter in a listing have to agree by construction, so they read the same
 * expression rather than two implementations of the same rule.
 *
 * It cannot be a Postgres generated column, tempting as that is next to `search_vector`:
 * the `stale` branch compares `review_by` against `now()`, and a generated column requires
 * an IMMUTABLE expression. Same constraint, recorded here so nobody spends an afternoon
 * discovering it again.
 *
 * ## Precedence, and why in this order
 *
 * 1. **Not indexed → no lifecycle at all.** A quarantined or withdrawn skill has a trust
 *    problem, and the page already says so in the language of trust. Answering "how proven
 *    is it" about a skill nobody may install is a category error, and a second badge
 *    competing with the withdrawal notice would only muddy it.
 * 2. **`superseded`**, then **`deprecated`** — a human's assertion outranks any measurement,
 *    because it carries intent that evidence cannot supply. Superseded first: it is the more
 *    useful of the two, since it comes with somewhere else to go.
 * 3. **`stale`** — detected, from an elapsed `review_by`.
 * 4. **`battle-tested`** — has no branch. See below.
 * 5. **`validated`** — the floor.
 *
 * ## Battle-tested has no branch, deliberately
 *
 * RK.1 wants it earned from post-publication evidence: installs, eval deltas, age without
 * incident. None of that is collected yet — that is R6.3, plan step B1 — so there is nothing
 * to earn it with, and inventing a proxy from what *is* available (age, quality score) would
 * be exactly the mistake the archetype miner made when it banded on `quality_score` and
 * confidently reported that good review skills are single-file with no code examples.
 *
 * So the tier is named in the vocabulary, absent from this expression, and
 * `verify:lifecycle` asserts no skill carries it. When B1 lands, one branch goes here and
 * nothing else changes.
 */

/**
 * The lifecycle state as a SQL expression over the `skills` row.
 *
 * Returns NULL for anything not `indexed`. Callers select it as a column; nothing recomputes
 * it in TypeScript.
 */
export function lifecycleExpression(): SQL<LifecycleState | null> {
  return sql<LifecycleState | null>`
    case
      when ${skills.status} <> 'indexed' then null
      when ${skills.lifecycleDeclaration} = 'superseded' then 'superseded'
      when ${skills.lifecycleDeclaration} = 'deprecated' then 'deprecated'
      when ${skills.reviewBy} is not null and ${skills.reviewBy} < now() then 'stale'
      else 'validated'
    end
  `;
}

export type LifecycleDetail = {
  state: LifecycleState | null;
  note: string | null;
  reviewBy: Date | null;
  /** The replacement, resolved to something a reader can click. */
  supersededBy: { slug: string; name: string } | null;
};

export type DeclareInput = {
  skillId: string;
  /** `null` clears the declaration and returns the skill to its derived state. */
  declaration: LifecycleDeclaration | null;
  /** Required when declaring `superseded`; ignored otherwise. */
  supersededBySkillId?: string | null;
  note?: string | null;
  actorId: string;
};

export type DeclareResult = { ok: true; state: LifecycleState | null } | { ok: false; error: string };

/**
 * Record a lifecycle declaration, with its audit event, in one transaction.
 *
 * `server-only` and takes an explicit `actorId`: it is a curator operation, so the caller
 * resolves the session and this checks the arguments. Never `"use server"` — the same rule
 * every function taking an explicit id follows in this codebase.
 */
export async function declareLifecycle(input: DeclareInput): Promise<DeclareResult> {
  if (input.declaration !== null && !isLifecycleDeclaration(input.declaration)) {
    return { ok: false, error: `Not a declarable state: ${String(input.declaration)}` };
  }

  /**
   * A supersession without a replacement is the failure mode this whole state exists to
   * avoid. "Superseded" tells a reader to go elsewhere; if it cannot say where, it is a
   * worse version of "deprecated" and should have been that instead.
   */
  if (input.declaration === "superseded" && !input.supersededBySkillId) {
    return { ok: false, error: "Superseded needs the skill that replaces it." };
  }
  if (input.supersededBySkillId && input.supersededBySkillId === input.skillId) {
    return { ok: false, error: "A skill cannot supersede itself." };
  }

  const [target] = await db
    .select({ id: skills.id, slug: skills.slug, orgId: skills.orgId, status: skills.status })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);
  if (!target) return { ok: false, error: "No such skill." };

  if (input.supersededBySkillId) {
    const [replacement] = await db
      .select({ id: skills.id, orgId: skills.orgId, status: skills.status })
      .from(skills)
      .where(eq(skills.id, input.supersededBySkillId))
      .limit(1);
    if (!replacement) return { ok: false, error: "The replacement skill does not exist." };
    /**
     * Both checks matter and stop different things.
     *
     * A replacement that is not servable sends a reader to a dead end — worse than no
     * pointer, because the page has already told them to go there. And pointing across a
     * tenant boundary would leak the existence of a private skill to anyone who can read the
     * public one, which is RC.5's concern arriving through an unexpected door.
     */
    if (replacement.status !== "indexed") {
      return { ok: false, error: "The replacement is not servable, so it cannot be the answer." };
    }
    if (replacement.orgId !== target.orgId) {
      return { ok: false, error: "A replacement must live in the same workspace." };
    }
  }

  await db.transaction(async (tx) => {
    if (target.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${target.orgId}, true)`);
    }

    await tx
      .update(skills)
      .set({
        lifecycleDeclaration: input.declaration,
        // Cleared alongside the declaration, so a lifted deprecation cannot leave a
        // dangling "replaced by" pointer behind it.
        supersededBySkillId: input.declaration === "superseded" ? input.supersededBySkillId : null,
        lifecycleNote: input.declaration === null ? null : (input.note ?? null),
        lifecycleChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, input.skillId));

    /**
     * Inside the transaction, and org-scoped by the `set_config` above.
     *
     * `publishDraft` shipped this wrong once: the audit row went in after the transaction
     * with a plain handle and RLS refused it outright, so a skill could exist with no record
     * of who published it. R7.1 exists to close exactly that gap.
     */
    await tx.insert(events).values({
      orgId: target.orgId,
      actorType: "user",
      actorId: input.actorId,
      kind: input.declaration === null ? "lifecycle.cleared" : `lifecycle.${input.declaration}`,
      subjectType: "skill",
      subjectId: input.skillId,
      reason: input.note ?? null,
      payload: {
        slug: target.slug,
        declaration: input.declaration,
        supersededBySkillId: input.supersededBySkillId ?? null,
      },
    });
  });

  const [after] = await db
    .select({ state: lifecycleExpression() })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);

  return { ok: true, state: after?.state ?? null };
}

/**
 * Set or clear the review-by date. A separate operation from a declaration, on purpose.
 *
 * The first version folded this into `declareLifecycle` and the seam leaked immediately:
 * setting a review date on an undeclared skill passed `declaration: null`, which wrote an
 * audit event reading **lifecycle.cleared** and wiped any existing note. One function
 * meaning two things produced a log that was confidently wrong about what an operator did —
 * which is the one thing an audit trail may not be.
 *
 * A review date is content governance, not a state: it is an input the `stale` derivation
 * reads, and it moves independently of whether anyone has deprecated anything.
 */
export async function setReviewDate(input: {
  skillId: string;
  /** `null` removes the date, so the skill can no longer become stale from expiry. */
  reviewBy: Date | null;
  ownerId?: string | null;
  actorId: string;
}): Promise<DeclareResult> {
  const [target] = await db
    .select({ id: skills.id, slug: skills.slug, orgId: skills.orgId })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);
  if (!target) return { ok: false, error: "No such skill." };

  await db.transaction(async (tx) => {
    if (target.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${target.orgId}, true)`);
    }
    await tx
      .update(skills)
      .set({
        reviewBy: input.reviewBy,
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, input.skillId));

    await tx.insert(events).values({
      orgId: target.orgId,
      actorType: "user",
      actorId: input.actorId,
      kind: input.reviewBy === null ? "lifecycle.review-cleared" : "lifecycle.review-set",
      subjectType: "skill",
      subjectId: input.skillId,
      payload: {
        slug: target.slug,
        reviewBy: input.reviewBy?.toISOString() ?? null,
        ownerId: input.ownerId ?? null,
      },
    });
  });

  const [after] = await db
    .select({ state: lifecycleExpression() })
    .from(skills)
    .where(eq(skills.id, input.skillId))
    .limit(1);
  return { ok: true, state: after?.state ?? null };
}

/** Counts per derived state, for the CLI and a future settings panel. */
export async function lifecycleSummary() {
  const rows = await db
    .select({
      state: sql<string>`coalesce(${lifecycleExpression()}, 'not-applicable')`,
      count: sql<number>`count(*)::int`,
    })
    .from(skills)
    .groupBy(sql`1`)
    .orderBy(sql`count(*) desc`);

  const [governance] = await db
    .select({
      withReviewDate: sql<number>`count(*) filter (where ${skills.reviewBy} is not null)::int`,
      withOwner: sql<number>`count(*) filter (where ${skills.ownerId} is not null)::int`,
      overdue: sql<number>`count(*) filter (where ${skills.reviewBy} < now())::int`,
    })
    .from(skills);

  return { rows, governance };
}
