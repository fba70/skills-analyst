import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  isFlagReason,
  MAX_FLAG_CONTACT,
  MAX_FLAG_NOTE,
  triageOf,
  TRIAGE_ORDER,
  type FlagReason,
  type FlagStatus,
} from "@/lib/flags";
import { callerDigest, utcDay } from "@/server/analytics/outcomes";
import { db } from "@/server/db";
import { events, skillFlags, skills, skillVersions } from "@/server/db/schema";

/**
 * Community flagging (Doc 2 R2.5) — recording a reader's report, and deciding on it.
 *
 * ## Recording and deciding are separate operations, and separate functions
 *
 * `submitFlag` writes a `received` row and does nothing else. It quarantines no skill,
 * changes no score and hides nothing. `upholdFlag` is what has consequences, and it is
 * admin-only.
 *
 * That split is not caution. Enforcing on arrival means **anybody who can fill in a form can
 * un-list a competitor** — the failure every takedown regime is criticised for, and the
 * reason `takedowns` already works this way. The temptation is strongest for a
 * credible-sounding `malicious` report, which is exactly what an attacker would file.
 *
 * ## Only an upheld flag becomes an outcome signal
 *
 * `flagged` is an adverse outcome (R6.3), and adverse outcomes bar a skill from
 * `battle-tested`. If a *received* flag recorded one, an accusation alone would strip a trust
 * tier — a two-line form defeating a month of downloads and a clean re-validation. So the
 * signal is written on uphold, by a named admin, with their reasoning on the row.
 *
 * ## The reporter is not identified
 *
 * The digest is the same daily-rotating unlinkable HMAC the outcome signals use, and it does
 * two jobs: refusing a duplicate report of the same skill for the same reason on the same
 * day, and giving the rate limiter something to count. A contact address is stored only when
 * the reporter volunteers one.
 */

export type SubmitFlagInput = {
  slug: string;
  reason: string;
  note?: string | null;
  contact?: string | null;
  /** Something stable about the reporter. Hashed, never stored. */
  callerKey: string | null;
};

export type SubmitFlagResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: string };

export async function submitFlag(input: SubmitFlagInput): Promise<SubmitFlagResult> {
  if (!isFlagReason(input.reason)) {
    return { ok: false, error: "Choose one of the listed reasons." };
  }

  const [skill] = await db
    .select({
      id: skills.id,
      orgId: skills.orgId,
      versionId: skills.currentVersionId,
      status: skills.status,
    })
    .from(skills)
    .where(eq(skills.slug, input.slug))
    .orderBy(sql`${skills.canonicalSkillId} asc nulls first`, desc(skills.qualityScore))
    .limit(1);

  if (!skill || !skill.versionId) {
    return { ok: false, error: "No such skill." };
  }
  /**
   * A withdrawn skill cannot be flagged.
   *
   * Its content is already gone, so there is nothing for a curator to look at, and the queue
   * should not fill with reports about things that have already been removed. Quarantined
   * skills *can* be flagged: they are visible to curators and a reader may have spotted
   * something the analyzers did not.
   */
  if (skill.status === "withdrawn") {
    return { ok: false, error: "This skill has already been withdrawn." };
  }

  const day = utcDay();
  const digest = callerDigest(input.callerKey, day);

  const inserted = await db.transaction(async (tx) => {
    if (skill.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${skill.orgId}, true)`);
    }
    const rows = await tx
      .insert(skillFlags)
      .values({
        orgId: skill.orgId,
        skillId: skill.id,
        skillVersionId: skill.versionId!,
        reason: input.reason as FlagReason,
        // Trimmed and capped here rather than trusted from the form: a server action is a
        // POST endpoint, so the client-side `maxLength` is a hint and not a constraint.
        note: input.note?.trim().slice(0, MAX_FLAG_NOTE) || null,
        contact: input.contact?.trim().slice(0, MAX_FLAG_CONTACT) || null,
        reporterDigest: digest,
        day,
      })
      // The dedup lives in the index. A second identical report today is the same report.
      .onConflictDoNothing({
        target: [
          skillFlags.skillVersionId,
          skillFlags.reason,
          skillFlags.day,
          skillFlags.reporterDigest,
        ],
      })
      .returning({ id: skillFlags.id });

    if (rows.length > 0) {
      /**
       * The audit row records that a report arrived, not who sent it (R7.1).
       *
       * `actorType: "system"` because there is no account behind it and inventing one would
       * make the log confidently wrong — the same reasoning the lifecycle CLI uses for `cli`.
       */
      await tx.insert(events).values({
        orgId: skill.orgId,
        actorType: "system",
        actorId: "public.flag",
        kind: "flag.received",
        subjectType: "skill",
        subjectId: skill.id,
        reason: input.reason,
        payload: { reason: input.reason, triage: triageOf(input.reason as FlagReason) },
      });
    }
    return rows.length;
  });

  /**
   * A duplicate is reported as success, deliberately.
   *
   * Telling a reporter "you already flagged this today" confirms that a previous submission
   * landed, which is a small oracle and a needless one — they filed the same report, and the
   * outcome they want (a curator looks) is unchanged. It is surfaced as `duplicate` so the
   * caller can vary the wording, not the outcome.
   */
  return { ok: true, duplicate: inserted === 0 };
}

export type FlagQueueRow = {
  id: string;
  slug: string;
  name: string;
  skillStatus: string;
  reason: FlagReason;
  note: string | null;
  contact: string | null;
  status: FlagStatus;
  createdAt: Date;
  /** True when a newer version has replaced the one that was reported. */
  stale: boolean;
};

/**
 * The queue a curator works through, security first.
 *
 * Ordered by triage then age. `triageOf` is derived from the reason rather than stored, so
 * the ordering cannot drift from the vocabulary — the same reasoning that keeps outcome
 * valence out of a column.
 */
export async function flagQueue(status: FlagStatus = "received"): Promise<FlagQueueRow[]> {
  const rows = await db
    .select({
      id: skillFlags.id,
      slug: skills.slug,
      name: skills.name,
      skillStatus: skills.status,
      reason: skillFlags.reason,
      note: skillFlags.note,
      contact: skillFlags.contact,
      status: skillFlags.status,
      createdAt: skillFlags.createdAt,
      reportedVersion: skillFlags.skillVersionId,
      currentVersion: skills.currentVersionId,
    })
    .from(skillFlags)
    .innerJoin(skills, eq(skills.id, skillFlags.skillId))
    .where(eq(skillFlags.status, status))
    .orderBy(desc(skillFlags.createdAt))
    .limit(200);

  return rows
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      skillStatus: row.skillStatus,
      reason: row.reason as FlagReason,
      note: row.note,
      contact: row.contact,
      status: row.status as FlagStatus,
      createdAt: row.createdAt,
      /**
       * Surfaced rather than hidden. "This is broken" is a statement about content, and a
       * re-sync may have replaced it before anyone read the report — a curator who cannot
       * tell a stale report from a live one will eventually re-quarantine a fixed skill.
       */
      stale: row.reportedVersion !== row.currentVersion,
    }))
    .sort(
      (a, b) =>
        TRIAGE_ORDER[triageOf(a.reason)] - TRIAGE_ORDER[triageOf(b.reason)] ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
}

export type DecideResult = { ok: true } | { ok: false; error: string };

/**
 * Uphold a flag: the only operation here with consequences.
 *
 * Records the R6.3 outcome signal and queues the version for re-validation. It does **not**
 * quarantine directly — that decision belongs to the analyzers, and a curator forcing a
 * status would produce a quarantined skill with no verdict row explaining why, which is the
 * gap R7.1 exists to close. `revalidating` is the honest state: unserved, queued, and the
 * next validate pass writes real verdicts.
 */
export async function upholdFlag(
  id: string,
  decision: string,
  actorId: string,
): Promise<DecideResult> {
  const [flag] = await db
    .select({
      id: skillFlags.id,
      orgId: skillFlags.orgId,
      skillId: skillFlags.skillId,
      skillVersionId: skillFlags.skillVersionId,
      reason: skillFlags.reason,
      status: skillFlags.status,
    })
    .from(skillFlags)
    .where(eq(skillFlags.id, id))
    .limit(1);

  if (!flag) return { ok: false, error: "No such flag." };
  if (flag.status !== "received") {
    return { ok: false, error: `Already ${flag.status}.` };
  }
  if (!decision.trim()) {
    // A decision with no reasoning is the thing that makes a queue unauditable later.
    return { ok: false, error: "Say why, so the decision can be read back." };
  }

  await db.transaction(async (tx) => {
    if (flag.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${flag.orgId}, true)`);
    }
    await tx
      .update(skillFlags)
      .set({
        status: "upheld",
        decision: decision.trim().slice(0, 1_000),
        decidedAt: new Date(),
        decidedBy: actorId,
      })
      .where(eq(skillFlags.id, id));

    /**
     * Queue the version for re-validation rather than quarantining it.
     *
     * Only when it is currently served: re-queueing an already-quarantined version would
     * take it out of the curator's quarantine view and put it back in the validate queue for
     * no gain.
     */
    await tx
      .update(skillVersions)
      .set({ status: "revalidating" })
      .where(and(eq(skillVersions.id, flag.skillVersionId), eq(skillVersions.status, "indexed")));

    await tx.insert(events).values({
      orgId: flag.orgId,
      actorType: "user",
      actorId,
      kind: "flag.upheld",
      subjectType: "skill",
      subjectId: flag.skillId,
      reason: decision.trim().slice(0, 300),
      payload: { flagId: id, flagReason: flag.reason },
    });
  });

  /**
   * The outcome signal (R6.3), on uphold only.
   *
   * A named admin has agreed with the report, which is what makes it evidence rather than an
   * accusation. `flagged` is adverse and bars `battle-tested`, so writing it on receipt would
   * let a form defeat a month of clean downloads.
   */
  const { recordOutcome } = await import("@/server/analytics/outcomes");
  void recordOutcome({
    skillId: flag.skillId,
    skillVersionId: flag.skillVersionId,
    kind: "flagged",
  });

  return { ok: true };
}

/**
 * Reject a flag. Kept, not deleted.
 *
 * Same reasoning as a rejected takedown: a refused report is still a report that was made,
 * and that record is the half of this that protects the platform. It also stops the same
 * reporter's next identical flag looking like new information.
 */
export async function rejectFlag(
  id: string,
  decision: string,
  actorId: string,
): Promise<DecideResult> {
  if (!decision.trim()) return { ok: false, error: "Say why, so the decision can be read back." };

  const [flag] = await db
    .select({ orgId: skillFlags.orgId, skillId: skillFlags.skillId, status: skillFlags.status })
    .from(skillFlags)
    .where(eq(skillFlags.id, id))
    .limit(1);
  if (!flag) return { ok: false, error: "No such flag." };
  if (flag.status !== "received") return { ok: false, error: `Already ${flag.status}.` };

  await db.transaction(async (tx) => {
    if (flag.orgId) {
      await tx.execute(sql`select set_config('app.org_id', ${flag.orgId}, true)`);
    }
    await tx
      .update(skillFlags)
      .set({
        status: "rejected",
        decision: decision.trim().slice(0, 1_000),
        decidedAt: new Date(),
        decidedBy: actorId,
      })
      .where(eq(skillFlags.id, id));

    await tx.insert(events).values({
      orgId: flag.orgId,
      actorType: "user",
      actorId,
      kind: "flag.rejected",
      subjectType: "skill",
      subjectId: flag.skillId,
      reason: decision.trim().slice(0, 300),
      payload: { flagId: id },
    });
  });

  return { ok: true };
}

/** Counts per status and per triage, for the settings tab label and the loop panel. */
export async function flagSummary() {
  const rows = await db
    .select({
      status: skillFlags.status,
      reason: skillFlags.reason,
      n: sql<number>`count(*)::int`,
    })
    .from(skillFlags)
    .groupBy(skillFlags.status, skillFlags.reason);

  let open = 0;
  let security = 0;
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.n;
    if (row.status === "received") {
      open += row.n;
      if (triageOf(row.reason as FlagReason) === "security") security += row.n;
    }
  }
  return { open, security, byStatus };
}
