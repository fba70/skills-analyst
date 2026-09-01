import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { pipelineHeartbeat } from "@/server/db/schema";

/**
 * Where the pipeline is, written *while* it works.
 *
 * ## Why this exists
 *
 * Three separate incidents were diagnosed by hand with `ps` and `lsof`, because the only
 * thing the pipeline wrote was a completion event — and a run that hangs never completes.
 * "Working on a 6,000-skill repository" and "stalled on a dead socket" produced identical
 * evidence: no new events, a live process, no new rows for a while.
 *
 * A completion record cannot distinguish those two by construction. This can, and the whole
 * design follows from one question being answerable in one query: **how long since the
 * pipeline last made progress?**
 *
 * ## Throttled, because a heartbeat must not become the workload
 *
 * `beat()` is called from the per-skill loop, which runs thousands of times a minute. It
 * writes at most once every `BEAT_INTERVAL_MS`; the rest return immediately without touching
 * the database. Fifteen seconds is far below the minutes a stall takes to become suspicious
 * and far above the cost of a single-row upsert.
 *
 * ## It never throws
 *
 * Bookkeeping must not be able to fail the work it describes. A heartbeat that could kill a
 * six-hour ingestion run to report on it would be worse than no heartbeat — so every error
 * here is swallowed, which is the one place in this codebase where that is the right answer.
 */

const BEAT_INTERVAL_MS = 15_000;
const SINGLETON = "singleton";

let lastBeatAt = 0;
let passStartedAt: Date | null = null;

/** Called once when a pass begins, so a slow pass is distinguishable from a stalled one. */
export function startPass(): void {
  passStartedAt = new Date();
  lastBeatAt = 0; // the first beat of a pass always lands
}

export async function beat(
  stage: string,
  detail: string,
  progress?: { done?: number; total?: number },
  options: { force?: boolean } = {},
): Promise<void> {
  const now = Date.now();
  if (!options.force && now - lastBeatAt < BEAT_INTERVAL_MS) return;
  lastBeatAt = now;

  try {
    await db
      .insert(pipelineHeartbeat)
      .values({
        id: SINGLETON,
        stage,
        detail: detail.slice(0, 300),
        itemsDone: progress?.done ?? null,
        itemsTotal: progress?.total ?? null,
        passStartedAt,
        updatedAt: new Date(),
        pid: process.pid,
      })
      .onConflictDoUpdate({
        target: pipelineHeartbeat.id,
        set: {
          stage,
          detail: detail.slice(0, 300),
          itemsDone: progress?.done ?? null,
          itemsTotal: progress?.total ?? null,
          passStartedAt,
          updatedAt: new Date(),
          pid: process.pid,
        },
      });
  } catch {
    // Never fail the work being reported on.
  }
}

export type Heartbeat = {
  stage: string | null;
  detail: string | null;
  itemsDone: number | null;
  itemsTotal: number | null;
  pid: number | null;
  updatedAt: Date;
  passStartedAt: Date | null;
  /** The number that matters. */
  secondsSinceBeat: number;
  /**
   * Stale means "no progress for long enough that a human should look".
   *
   * Two minutes — eight missed beats. Generous enough that a slow single operation (a large
   * tree enumeration is allowed 120 seconds) cannot trip it, tight enough that a stall is
   * obvious long before it costs a night.
   */
  stale: boolean;
};

export async function readHeartbeat(): Promise<Heartbeat | null> {
  const [row] = await db
    .select()
    .from(pipelineHeartbeat)
    .where(eq(pipelineHeartbeat.id, SINGLETON))
    .limit(1);
  if (!row) return null;

  const seconds = Math.max(0, Math.round((Date.now() - row.updatedAt.getTime()) / 1000));
  return {
    stage: row.stage,
    detail: row.detail,
    itemsDone: row.itemsDone,
    itemsTotal: row.itemsTotal,
    pid: row.pid,
    updatedAt: row.updatedAt,
    passStartedAt: row.passStartedAt,
    secondsSinceBeat: seconds,
    stale: seconds > 120,
  };
}

/** Marks the pipeline as no longer running. Called when a run ends cleanly. */
export async function clearHeartbeat(): Promise<void> {
  try {
    await db.execute(sql`delete from pipeline_heartbeat where id = ${SINGLETON}`);
  } catch {
    /* bookkeeping */
  }
}
