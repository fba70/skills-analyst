import "server-only";

import { eq } from "drizzle-orm";

import { events, platformSettings } from "@/server/db/schema";
import { db } from "@/server/db";

/**
 * What the scheduler is allowed to do, and how often (Doc 2 R1.7, G2).
 *
 * ## What a "frequency" here actually is
 *
 * Vercel Cron fires on a fixed expression in `vercel.ts`, and nothing in a database can
 * change that. So the setting is **not** the cron expression — it is a minimum interval,
 * checked by the route when the cron does fire. A tick that arrives before a stage is due
 * returns without doing the work.
 *
 * That distinction is worth stating because the alternative reading is the obvious one and
 * it is wrong: an admin who sets "every 6 hours" while the cron ticks twice daily gets
 * twice-daily runs, not four. The UI says so rather than implying a control we do not have.
 * Raising the *ceiling* means editing `vercel.ts`; lowering the *rate* is what this does.
 *
 * ## Absent means default, and the default is off where off is safer
 *
 * The table is empty on a fresh deployment. A reader that treated a missing row as
 * `enabled: true` would have a scheduler fetching repositories before anybody configured
 * one, so every default is written down here and the risky ones are `false`.
 *
 * Archetype refresh ships **disabled** deliberately. It is free — no model call — but it
 * rewrites the guidance the builder scaffolds from, and it has never been run on a
 * schedule against a corpus this size. It gets switched on after a deliberate run, not
 * before one.
 */

export type StageSchedule = {
  enabled: boolean;
  /** Minimum hours between runs. See the note above — this throttles, it cannot accelerate. */
  everyHours: number;
};

export type ScheduleSettings = {
  /** Sync, validate, fingerprint, signatures, cluster. Free — no model calls. */
  pipeline: StageSchedule & {
    /** Sources per pass. The freshness budget, not a catch-up rate. */
    sourcesPerPass: number;
    /** A pass will not start a source larger than this (R1.5 needs whole enumerations). */
    maxSkillsPerSource: number;
  };
  /**
   * Archetype mining (G2 asks for a weekly refresh).
   *
   * Free, but it changes published guidance, so it is off until somebody has watched it
   * run once.
   */
  archetypes: StageSchedule;
};

/**
 * The defaults, which are also the documentation.
 *
 * The pipeline numbers are the ones that were hard-coded in the cron route, moved here
 * unchanged: six sources and 120 skills per source were both measured against the function
 * ceiling after a pass timed out at 800 seconds on a single repository.
 */
export const SCHEDULE_DEFAULTS: ScheduleSettings = {
  pipeline: {
    enabled: true,
    everyHours: 12,
    sourcesPerPass: 6,
    maxSkillsPerSource: 120,
  },
  archetypes: {
    // Off. See the note above.
    enabled: false,
    // Weekly, which is what G2 asks for once it is switched on.
    everyHours: 168,
  },
};

const KEY = "schedule";

export async function getSchedule(): Promise<ScheduleSettings> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, KEY))
    .limit(1);

  const stored = (row?.value ?? {}) as Partial<ScheduleSettings>;

  // Merged field by field rather than replaced wholesale: a settings row written before a
  // knob existed must not make that knob `undefined`, and a partial write must not silently
  // switch off something it never mentioned.
  return {
    pipeline: { ...SCHEDULE_DEFAULTS.pipeline, ...(stored.pipeline ?? {}) },
    archetypes: { ...SCHEDULE_DEFAULTS.archetypes, ...(stored.archetypes ?? {}) },
  };
}

/** Bounds, so a typo cannot make the scheduler hammer or hibernate. */
const LIMITS = {
  everyHours: { min: 1, max: 24 * 30 },
  sourcesPerPass: { min: 1, max: 25 },
  maxSkillsPerSource: { min: 10, max: 500 },
} as const;

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(value)));

/**
 * Writes the schedule and records who changed it.
 *
 * The `events` row is not optional bookkeeping. This is the control that decides whether
 * the platform fetches anything at all, and "why did ingestion stop three weeks ago" is a
 * question with exactly one good answer: because someone turned it off, on this date, and
 * here is the row that says so.
 */
export async function setSchedule(
  next: ScheduleSettings,
  actor: { userId: string; email: string },
): Promise<ScheduleSettings> {
  const previous = await getSchedule();

  const sanitised: ScheduleSettings = {
    pipeline: {
      enabled: Boolean(next.pipeline.enabled),
      everyHours: clamp(next.pipeline.everyHours, LIMITS.everyHours),
      sourcesPerPass: clamp(next.pipeline.sourcesPerPass, LIMITS.sourcesPerPass),
      maxSkillsPerSource: clamp(next.pipeline.maxSkillsPerSource, LIMITS.maxSkillsPerSource),
    },
    archetypes: {
      enabled: Boolean(next.archetypes.enabled),
      everyHours: clamp(next.archetypes.everyHours, LIMITS.everyHours),
    },
  };

  await db.transaction(async (tx) => {
    await tx
      .insert(platformSettings)
      .values({ key: KEY, value: sanitised, updatedBy: actor.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: platformSettings.key,
        set: { value: sanitised, updatedBy: actor.userId, updatedAt: new Date() },
      });

    await tx.insert(events).values({
      actorType: "user",
      actorId: actor.userId,
      kind: "schedule.changed",
      subjectType: "platform_settings",
      subjectId: KEY,
      reason: describeChange(previous, sanitised),
      payload: { previous, next: sanitised, by: actor.email },
    });
  });

  return sanitised;
}

function describeChange(before: ScheduleSettings, after: ScheduleSettings): string {
  const parts: string[] = [];
  if (before.pipeline.enabled !== after.pipeline.enabled) {
    parts.push(`ingestion ${after.pipeline.enabled ? "enabled" : "disabled"}`);
  }
  if (before.archetypes.enabled !== after.archetypes.enabled) {
    parts.push(`archetype refresh ${after.archetypes.enabled ? "enabled" : "disabled"}`);
  }
  if (before.pipeline.everyHours !== after.pipeline.everyHours) {
    parts.push(`ingestion every ${after.pipeline.everyHours}h`);
  }
  if (before.archetypes.everyHours !== after.archetypes.everyHours) {
    parts.push(`archetypes every ${after.archetypes.everyHours}h`);
  }
  if (before.pipeline.sourcesPerPass !== after.pipeline.sourcesPerPass) {
    parts.push(`${after.pipeline.sourcesPerPass} sources per pass`);
  }
  if (before.pipeline.maxSkillsPerSource !== after.pipeline.maxSkillsPerSource) {
    parts.push(`max ${after.pipeline.maxSkillsPerSource} skills per source`);
  }
  return parts.length > 0 ? parts.join("; ") : "saved with no change";
}

export type StageDue = {
  enabled: boolean;
  due: boolean;
  lastRunAt: Date | null;
  /** Null when the stage has never run or is disabled. */
  nextDueAt: Date | null;
  reason: string;
};

/**
 * Whether a stage should do anything on this tick.
 *
 * "Last run" is read from `events` rather than from a column on the settings row. The
 * events table already records every pass (R7.1) and is the thing an operator reads when
 * asking what happened; a second timestamp maintained beside it is a second source of truth
 * that can disagree with the first, and the one that disagrees is always the one nobody is
 * looking at.
 */
export async function stageDue(
  stage: "pipeline" | "archetypes",
  schedule: ScheduleSettings,
): Promise<StageDue> {
  const config = schedule[stage];

  if (!config.enabled) {
    return {
      enabled: false,
      due: false,
      lastRunAt: null,
      nextDueAt: null,
      reason: "switched off",
    };
  }

  const kinds =
    stage === "pipeline"
      ? ["pipeline.completed", "pipeline.partial"]
      : ["archetype.mined", "archetype.refresh.skipped"];

  const lastRunAt = await latestRun(kinds);
  if (!lastRunAt) {
    return {
      enabled: true,
      due: true,
      lastRunAt: null,
      nextDueAt: null,
      reason: "never run",
    };
  }

  const nextDueAt = new Date(lastRunAt.getTime() + config.everyHours * 3_600_000);
  const due = Date.now() >= nextDueAt.getTime();

  return {
    enabled: true,
    due,
    lastRunAt,
    nextDueAt,
    reason: due
      ? `due — last run ${Math.round((Date.now() - lastRunAt.getTime()) / 3_600_000)}h ago`
      : `not due for ${Math.round((nextDueAt.getTime() - Date.now()) / 3_600_000)}h`,
  };
}

async function latestRun(kinds: string[]): Promise<Date | null> {
  const { desc, inArray } = await import("drizzle-orm");
  const [row] = await db
    .select({ at: events.at })
    .from(events)
    .where(inArray(events.kind, kinds))
    .orderBy(desc(events.at))
    .limit(1);
  return row?.at ?? null;
}
