import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { events, platformSettings } from "@/server/db/schema";

/**
 * How much a caller may ask for, per scope (Doc 2 R8.8).
 *
 * ## Why this is data and not a constant
 *
 * The same argument the ingest schedule already makes. A limit is tuned against live
 * behaviour — you find out it is wrong when a legitimate agent trips it, or when a runaway
 * one does not — and tuning through a redeploy is too slow to learn anything. Worse, the
 * emergency case runs the other way: the reason to change this at 3am is that something is
 * hammering the endpoint, which is exactly when waiting for a build is unaffordable.
 *
 * ## Two windows, because they stop different things
 *
 * A per-minute limit stops a tight loop. A per-hour limit stops a patient one — a caller
 * pacing itself just under the minute limit would otherwise run all day. Neither substitutes
 * for the other: a single hourly limit lets a client burn its whole allowance in ten seconds
 * and then sit dead for an hour, and a single per-minute limit caps nothing in aggregate.
 *
 * ## The paid scope exists and is not reachable yet
 *
 * There are no entitlements (RC.1), so `resolveTier` below always answers `free` and the
 * paid numbers are stored and unused. That is deliberate rather than decorative: the code
 * path that selects a tier is real and tested, so when entitlements land the limiter needs
 * no new branch — and the admin panel says plainly that the paid row is not in effect,
 * because a control that silently does nothing is worse than an absent one.
 */

export type ScopeLimits = {
  enabled: boolean;
  perMinute: number;
  perHour: number;
};

export type RateLimitSettings = {
  /** Anonymous callers of the free MCP scope. Everyone, today. */
  mcpFree: ScopeLimits;
  /** Authenticated, entitled callers. Stored; unreachable until RC.1. */
  mcpPaid: ScopeLimits;
};

/**
 * The defaults, which are also the documentation.
 *
 * 60/minute is roughly one call a second — comfortably above an agent working through a
 * task (search, read three skills, fetch one) and far below a loop. 600/hour then allows ten
 * such sessions an hour from one address, which is generous for a single user and cheap for
 * us, while still bounding the damage from a client that never stops.
 *
 * They are deliberately not tight. A first limit that blocks real use teaches everyone to
 * raise it and trust it less; one that only catches genuine runaways can be tightened later
 * with evidence.
 */
export const RATE_LIMIT_DEFAULTS: RateLimitSettings = {
  mcpFree: { enabled: true, perMinute: 60, perHour: 600 },
  mcpPaid: { enabled: true, perMinute: 600, perHour: 20_000 },
};

const KEY = "rate-limits";

export async function getRateLimits(): Promise<RateLimitSettings> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, KEY))
    .limit(1);

  const stored = (row?.value ?? {}) as Partial<RateLimitSettings>;

  // Merged field by field, as the schedule is: a row written before a knob existed must not
  // make that knob `undefined`, and a partial write must not switch off what it never named.
  return {
    mcpFree: { ...RATE_LIMIT_DEFAULTS.mcpFree, ...(stored.mcpFree ?? {}) },
    mcpPaid: { ...RATE_LIMIT_DEFAULTS.mcpPaid, ...(stored.mcpPaid ?? {}) },
  };
}

/**
 * Bounds, so a typo cannot lock everyone out or switch the limit off by making it enormous.
 *
 * The floor is 1 rather than 0 because 0 means "refuse everything", and an admin who wants
 * that has a checkbox that says so. A number that quietly means the same thing as a switch
 * is how a control gets used by accident.
 */
const LIMITS = {
  perMinute: { min: 1, max: 100_000 },
  perHour: { min: 1, max: 5_000_000 },
} as const;

const clamp = (value: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

function sanitiseScope(next: ScopeLimits): ScopeLimits {
  const perMinute = clamp(next.perMinute, LIMITS.perMinute);
  const perHour = clamp(next.perHour, LIMITS.perHour);
  return {
    enabled: Boolean(next.enabled),
    perMinute,
    // An hourly cap below the per-minute cap is unreachable by construction and makes the
    // minute limit a lie. Raised to match rather than rejected: the admin's intent is
    // legible either way, and refusing a save over an arithmetic detail is not help.
    perHour: Math.max(perHour, perMinute),
  };
}

/**
 * Writes the limits and records who changed them.
 *
 * The `events` row is the whole audit trail for rate limiting — the counters themselves are
 * ephemeral and prunable. "Why did every agent start getting 429s on Tuesday" needs one good
 * answer, and it is a row naming the person and the number.
 */
export async function setRateLimits(
  next: RateLimitSettings,
  actor: { userId: string; email: string },
): Promise<RateLimitSettings> {
  const previous = await getRateLimits();
  const sanitised: RateLimitSettings = {
    mcpFree: sanitiseScope(next.mcpFree),
    mcpPaid: sanitiseScope(next.mcpPaid),
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
      kind: "rate-limits.changed",
      subjectType: "platform_settings",
      subjectId: KEY,
      reason: describeChange(previous, sanitised),
      payload: { previous, next: sanitised, by: actor.email },
    });
  });

  return sanitised;
}

function describeChange(before: RateLimitSettings, after: RateLimitSettings): string {
  const parts: string[] = [];
  for (const scope of ["mcpFree", "mcpPaid"] as const) {
    const label = scope === "mcpFree" ? "free" : "paid";
    if (before[scope].enabled !== after[scope].enabled) {
      parts.push(`${label} limit ${after[scope].enabled ? "enabled" : "disabled"}`);
    }
    if (before[scope].perMinute !== after[scope].perMinute) {
      parts.push(`${label} ${after[scope].perMinute}/min`);
    }
    if (before[scope].perHour !== after[scope].perHour) {
      parts.push(`${label} ${after[scope].perHour}/hour`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : "saved with no change";
}
