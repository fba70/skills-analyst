import "server-only";

import { createHmac } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  ADVERSE_KINDS,
  BATTLE_TESTED,
  DOWNLOAD_KINDS,
  isOutcomeKind,
  OUTCOME_KINDS,
  UNIMPLEMENTED_KINDS,
  valenceOf,
  type OutcomeKind,
} from "@/lib/outcomes";
import { db } from "@/server/db";
import { outcomeSignals, skills, skillVersions } from "@/server/db/schema";

/**
 * Recording and aggregating outcome signals (Doc 2 R6.3).
 *
 * ## It never throws, and that is a decision with a precedent
 *
 * `recordOutcome` swallows its own failures. The heartbeat took the same position for the
 * same reason: bookkeeping that can kill the operation it is reporting on is worse than no
 * bookkeeping. A reader downloading a skill must not receive a 500 because a telemetry
 * insert hit a unique violation or a cold Neon compute.
 *
 * That posture has a known cost, and this codebase has already paid it once: `recordUsage`
 * swallowed an RLS refusal, so builder spend was never metered and the failure was a log
 * line nobody read. The defence is not to remove the swallow — it is that
 * `verify:outcomes` asserts rows actually arrive, by writing one through the real path and
 * reading it back. A silent recorder is only safe if something else is loud.
 *
 * ## The caller digest identifies nobody
 *
 * A daily-rotating HMAC of the caller key, truncated to 16 hex characters. It exists purely
 * so one reader taking one skill twice in a day counts once (R6.5's dedup-per-identity), and
 * it is not linkable across days or back to an address. No IP, user agent, session or token
 * id is ever stored.
 *
 * With `OUTCOME_SALT` unset it degrades to a per-day constant — every caller collides and a
 * skill records at most one download a day. That direction is chosen: it **undercounts**, and
 * a signal that can move published guidance must never fail towards counting more.
 */

/** Truncated: 64 bits is ample for collision-free dedup within a single day. */
const DIGEST_CHARS = 16;

export const SYSTEM_CALLER = "system";

/**
 * A stable-for-today, unlinkable-tomorrow digest of a caller.
 *
 * The day is inside the HMAC key rather than only in the message, so yesterday's digests
 * cannot be recomputed from today's salt — which is what makes "not linkable across days"
 * a property of the construction rather than a promise about how we query.
 */
export function callerDigest(callerKey: string | null, day: string): string {
  if (!callerKey) return SYSTEM_CALLER;
  const salt = process.env.OUTCOME_SALT ?? "";
  return createHmac("sha256", `${salt}:${day}`)
    .update(callerKey)
    .digest("hex")
    .slice(0, DIGEST_CHARS);
}

/** UTC calendar day, as the `date` column stores it. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type RecordOutcomeInput = {
  skillId: string;
  skillVersionId: string;
  kind: OutcomeKind;
  /**
   * Something stable about the caller — an IP, or a token id. Hashed, never stored.
   * `null` for a system-generated signal.
   */
  callerKey?: string | null;
  value?: number | null;
  at?: Date;
};

/**
 * Record one outcome. Deduplicated by the unique index, and silent on failure.
 *
 * Resolves the skill's archetype lineage itself rather than taking it from the caller. Two
 * reasons: a download route has no reason to know what an archetype is, and a caller that
 * *could* supply it could also supply the wrong one — attribution that a call site can get
 * wrong is attribution that will be wrong somewhere.
 */
export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
  try {
    if (!isOutcomeKind(input.kind)) return;

    const day = utcDay(input.at);
    const digest = callerDigest(input.callerKey ?? null, day);

    const [version] = await db
      .select({
        orgId: skillVersions.orgId,
        provenance: skillVersions.provenance,
      })
      .from(skillVersions)
      .where(eq(skillVersions.id, input.skillVersionId))
      .limit(1);
    if (!version) return;

    /**
     * Lineage comes from the version's provenance, which `publishDraft` wrote (R6.1).
     * Absent for every ingested skill, which is the honest majority case — they were never
     * scaffolded from an archetype, so there is nothing to attribute to.
     */
    const provenance = (version.provenance ?? {}) as {
      archetypeCategory?: unknown;
      archetypeVersion?: unknown;
    };
    const category =
      typeof provenance.archetypeCategory === "string" ? provenance.archetypeCategory : null;
    const archetypeVersion =
      typeof provenance.archetypeVersion === "number" ? provenance.archetypeVersion : null;

    await db.transaction(async (tx) => {
      if (version.orgId) {
        await tx.execute(sql`select set_config('app.org_id', ${version.orgId}, true)`);
      }
      await tx
        .insert(outcomeSignals)
        .values({
          orgId: version.orgId,
          skillId: input.skillId,
          skillVersionId: input.skillVersionId,
          kind: input.kind,
          archetypeCategory: category,
          archetypeVersion,
          day,
          callerDigest: digest,
          value: input.value ?? null,
          ...(input.at ? { at: input.at } : {}),
        })
        // The dedup. A second identical signal in the same day is the same signal.
        .onConflictDoNothing({
          target: [
            outcomeSignals.skillVersionId,
            outcomeSignals.kind,
            outcomeSignals.day,
            outcomeSignals.callerDigest,
          ],
        });
    });
  } catch {
    // Deliberately silent. See the note at the top of this file — and note that
    // `verify:outcomes` writes through this function and reads the row back, so a
    // permanently broken recorder is caught by something rather than by nobody.
  }
}

export type SkillOutcomes = {
  /** Deduplicated downloads across both channels. */
  downloads: number;
  revalidatedPass: number;
  adverse: number;
  byKind: Record<string, number>;
  firstIndexedAt: Date | null;
  /** Whether it currently meets every `BATTLE_TESTED` condition. */
  battleTested: boolean;
};

/**
 * One skill's record. Used by the lifecycle derivation and the skill page.
 *
 * The counts are of *rows*, which are already deduplicated per identity per day by the
 * unique index — so no `distinct` is needed here and none is written, because a `distinct`
 * that is not required reads as though the index cannot be trusted.
 */
export async function outcomesForSkill(skillId: string): Promise<SkillOutcomes> {
  const rows = await db
    .select({ kind: outcomeSignals.kind, n: sql<number>`count(*)::int` })
    .from(outcomeSignals)
    .where(eq(outcomeSignals.skillId, skillId))
    .groupBy(outcomeSignals.kind);

  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.kind] = row.n;

  const [skill] = await db
    .select({ firstSeenAt: skills.firstSeenAt })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);

  const downloads = DOWNLOAD_KINDS.reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0);
  const revalidatedPass = byKind["revalidated-pass"] ?? 0;
  const adverse = ADVERSE_KINDS.reduce((sum, kind) => sum + (byKind[kind] ?? 0), 0);

  const ageDays = skill?.firstSeenAt
    ? (Date.now() - skill.firstSeenAt.getTime()) / 86_400_000
    : 0;

  return {
    downloads,
    revalidatedPass,
    adverse,
    byKind,
    firstIndexedAt: skill?.firstSeenAt ?? null,
    battleTested:
      adverse <= BATTLE_TESTED.adverseAllowed &&
      downloads >= BATTLE_TESTED.minDownloads &&
      revalidatedPass >= BATTLE_TESTED.minRevalidations &&
      ageDays >= BATTLE_TESTED.minAgeDays,
  };
}

/**
 * When outcome collection actually began (plan step E4).
 *
 * Without it every count on a skill page is a lie by omission. B1 shipped the recorder long
 * after most of this corpus was indexed, so a skill first seen in August showing "0 downloads"
 * reads as *nobody wanted it* when the truth is *nobody was counting*. That is the same shape as
 * `archetypes --blocks` printing eleven rows of zeros at 1% coverage, and the same fix: carry the
 * denominator with the number.
 *
 * The earliest signal rather than a configured date, because a constant would be a second source
 * of truth for something the table already knows — and would be wrong the moment the table is
 * ever backfilled or pruned. `null` when nothing has ever been recorded, which the panel renders
 * as "not collecting yet" rather than as zero of anything.
 */
export async function outcomeCollectionStart(): Promise<Date | null> {
  const [row] = await db
    .select({ first: sql<Date | null>`min(${outcomeSignals.at})` })
    .from(outcomeSignals);
  return row?.first ? new Date(row.first) : null;
}

export type ArchetypeOutcomes = {
  category: string;
  version: number;
  /** Distinct skills that produced any signal. The sample size, stated. */
  skills: number;
  downloads: number;
  positive: number;
  negative: number;
  /** Negative share of signed signals, 0–100. Null when there are none. */
  adverseRate: number | null;
  /** False when the sample is too thin for any of this to mean anything. */
  usable: boolean;
};

/**
 * Minimum distinct skills before an archetype's outcomes are reportable.
 *
 * The same argument as `MIN_DISTINCT_ORGS` in creation telemetry, serving R6.5 and privacy
 * at once: an aggregate over one or two skills describes those skills, and relaxing it for
 * either purpose breaks the other. Set higher than that floor because a download is cheaper
 * to manufacture than a published draft.
 */
export const MIN_DISTINCT_SKILLS = 5;

/**
 * Outcomes per archetype version — R6.3's attribution half.
 *
 * **This will be empty for a long time and the shape says so rather than hiding it.** Only
 * skills published through the builder carry archetype lineage, and there is essentially one.
 * `usable` is false below the floor, so a caller cannot accidentally read three downloads as
 * evidence about a category.
 *
 * It does not feed the miner yet, deliberately. Creation telemetry earned that right by
 * accumulating enough signal to survive R6.5's trimming; this has not, and wiring a
 * near-empty input into the thing that scaffolds every future draft is how a loop poisons
 * itself with its own noise.
 */
export async function archetypeOutcomes(): Promise<ArchetypeOutcomes[]> {
  const rows = await db
    .select({
      category: outcomeSignals.archetypeCategory,
      version: outcomeSignals.archetypeVersion,
      kind: outcomeSignals.kind,
      skills: sql<number>`count(distinct ${outcomeSignals.skillId})::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(outcomeSignals)
    .where(sql`${outcomeSignals.archetypeCategory} is not null`)
    .groupBy(outcomeSignals.archetypeCategory, outcomeSignals.archetypeVersion, outcomeSignals.kind);

  const grouped = new Map<string, ArchetypeOutcomes>();
  for (const row of rows) {
    if (!row.category || row.version === null) continue;
    const key = `${row.category}@${row.version}`;
    const entry =
      grouped.get(key) ??
      ({
        category: row.category,
        version: row.version,
        skills: 0,
        downloads: 0,
        positive: 0,
        negative: 0,
        adverseRate: null,
        usable: false,
      } satisfies ArchetypeOutcomes);

    const kind = row.kind as OutcomeKind;
    if (isOutcomeKind(kind)) {
      if (DOWNLOAD_KINDS.includes(kind)) entry.downloads += row.n;
      const valence = valenceOf(kind);
      if (valence === "positive") entry.positive += row.n;
      if (valence === "negative") entry.negative += row.n;
    }
    entry.skills = Math.max(entry.skills, row.skills);
    grouped.set(key, entry);
  }

  return [...grouped.values()]
    .map((entry) => {
      const signed = entry.positive + entry.negative;
      return {
        ...entry,
        adverseRate: signed > 0 ? Math.round((entry.negative / signed) * 100) : null,
        usable: entry.skills >= MIN_DISTINCT_SKILLS,
      };
    })
    .sort((a, b) => b.downloads - a.downloads);
}

/** Corpus-wide coverage, for the loop dashboard and the CLI. */
export async function outcomeSummary() {
  const byKind = await db
    .select({ kind: outcomeSignals.kind, n: sql<number>`count(*)::int` })
    .from(outcomeSignals)
    .groupBy(outcomeSignals.kind)
    .orderBy(sql`count(*) desc`);

  const [totals] = await db
    .select({
      signals: sql<number>`count(*)::int`,
      skills: sql<number>`count(distinct ${outcomeSignals.skillId})::int`,
      attributed: sql<number>`count(*) filter (where ${outcomeSignals.archetypeCategory} is not null)::int`,
      days: sql<number>`count(distinct ${outcomeSignals.day})::int`,
    })
    .from(outcomeSignals);

  const [{ eligible }] = await db
    .select({ eligible: sql<number>`count(*)::int` })
    .from(skills)
    .where(and(eq(skills.status, "indexed"), sql`${skills.canonicalSkillId} is null`));

  return {
    byKind,
    totals,
    eligible,
    kinds: OUTCOME_KINDS as readonly string[],
    unimplemented: UNIMPLEMENTED_KINDS as readonly string[],
  };
}
