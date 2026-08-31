import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/server/db";
import { rateLimitBuckets } from "@/server/db/schema";
import { getRateLimits, type ScopeLimits } from "@/server/settings/rate-limits";

/**
 * The limit on the MCP endpoint (Doc 2 R8.8).
 *
 * `/api/mcp` is unauthenticated by design — R8.1 and RC.1 both say the trust surfaces must
 * not be gated — and it is built to be called by machines, in front of queries that touch a
 * database. That combination is the denial-of-wallet shape `CRON_SECRET` already exists to
 * prevent on the ingest route, except an agent in a loop finds it faster than a person will.
 *
 * ## Counting is one statement, deliberately
 *
 * Read-then-write would race: two concurrent calls both read 59, both write 60, and the
 * limit of 60 admits 61. The upsert below reads, decides whether the window rolled, and
 * increments inside a single atomic statement, so the count is correct under any
 * concurrency without a lock the application has to hold.
 *
 * ## A refused call still counts
 *
 * `count` is incremented before the limit is compared, so hammering a closed door keeps it
 * closed until the window rolls. The alternative — free retries once you are over — makes
 * the limit cheapest to ignore for exactly the caller it is aimed at.
 *
 * ## Failing open, and why that is the right way round here
 *
 * If the counter query itself fails, the request is allowed. That is the opposite of this
 * codebase's usual posture, and the difference is what failing closed would protect: a spend
 * cap that fails open costs money, so it refuses; a rate limit that fails closed takes the
 * public registry offline because a counter table was briefly unavailable. The thing behind
 * this endpoint is public read-only data, and the honest ranking of harms puts "readable
 * when the limiter is broken" above "dark when the limiter is broken".
 */

export type RateDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Which window was exhausted — the caller needs to know how long to wait. */
      window: "minute" | "hour";
      limit: number;
      /** Seconds until the window rolls. Becomes `Retry-After`. */
      retryAfterSeconds: number;
      resetAt: Date;
      message: string;
    };

const WINDOWS = {
  minute: 60,
  hour: 3_600,
} as const;

type WindowName = keyof typeof WINDOWS;

/**
 * The caller's identity, and an honest note about how weak it is.
 *
 * IP is the only handle an anonymous protocol gives us. It is shared by everyone behind one
 * NAT and trivially rotated by anyone who wants to, so this bounds accidents — a loop, a
 * misconfigured client — and not an adversary. The real fix is an identity, which is the
 * open question in §11 and a product decision rather than an engineering one.
 *
 * The forwarded header is trusted only because Vercel overwrites it at the edge. Reading it
 * on a deployment that does not is how a limiter is bypassed with one curl flag, so this
 * comment is the warning: if this ever runs behind anything else, verify the header first.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim();
  return ip ? `ip:${ip}` : "ip:unknown";
}

function windowStart(seconds: number, now: number): Date {
  return new Date(Math.floor(now / (seconds * 1000)) * seconds * 1000);
}

/** One atomic read-decide-increment. Returns the count *including* this call. */
async function bump(key: string, scope: string, start: Date): Promise<number> {
  const rows = await db
    .insert(rateLimitBuckets)
    .values({ bucketKey: key, scope, windowStart: start, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.bucketKey, rateLimitBuckets.scope],
      set: {
        // The window rolled, so the stored count belongs to a window that has passed and
        // restarts at this call rather than carrying over.
        count: sql`case when ${rateLimitBuckets.windowStart} = ${start.toISOString()}::timestamptz
                        then ${rateLimitBuckets.count} + 1 else 1 end`,
        windowStart: sql`greatest(${rateLimitBuckets.windowStart}, ${start.toISOString()}::timestamptz)`,
      },
    })
    .returning({ count: rateLimitBuckets.count });

  return rows[0]?.count ?? 1;
}

/**
 * Charge one call against a scope, and say whether it may proceed.
 *
 * Both windows are always charged, even when the first one already refuses. Charging only
 * up to the first failure would let a caller sitting on the minute limit never accumulate an
 * hourly count, so the patient-loop case the hour window exists for would never fire.
 */
export async function consume(
  request: Request,
  scopeName: "mcpFree" | "mcpPaid" = "mcpFree",
  identity?: string,
): Promise<RateDecision> {
  let limits: ScopeLimits;
  try {
    limits = (await getRateLimits())[scopeName];
  } catch {
    // Settings unreadable: see the fail-open note above.
    return { allowed: true };
  }
  if (!limits.enabled) return { allowed: true };

  /**
   * The token id when there is one, which is the whole reason MCP requires an account.
   *
   * `callerKey` remains as the fallback for any caller that reaches the limiter without a
   * credential. Nothing does today — the route refuses those before charging — and keeping
   * it means a future unauthenticated surface gets a weak limit rather than none.
   */
  const key = identity ?? callerKey(request);
  const now = Date.now();
  const checks: Array<{ name: WindowName; limit: number }> = [
    { name: "minute", limit: limits.perMinute },
    { name: "hour", limit: limits.perHour },
  ];

  let refusal: RateDecision | null = null;

  for (const check of checks) {
    const seconds = WINDOWS[check.name];
    const start = windowStart(seconds, now);
    let count: number;
    try {
      count = await bump(key, `${scopeName}:${check.name}`, start);
    } catch {
      continue; // fail open, per window
    }
    if (count > check.limit && !refusal) {
      const resetAt = new Date(start.getTime() + seconds * 1000);
      refusal = {
        allowed: false,
        window: check.name,
        limit: check.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
        resetAt,
        // R8.8: the refusal has to say which limit and when it lifts. An agent that cannot
        // tell "slow down" from "you may not do this" will retry a hard failure forever or
        // abandon a soft one — and both failures look like our bug from the outside.
        message:
          `Rate limit reached: ${check.limit} requests per ${check.name} for this caller. ` +
          `This is a throttle, not a permission failure — the same request will succeed ` +
          `after ${resetAt.toISOString()}.`,
      };
    }
  }

  return refusal ?? { allowed: true };
}

/**
 * Drops counters nobody is using. Free, offline, and safe to run at any time.
 *
 * A row survives only as long as its caller keeps calling; once they stop, it sits at a
 * window that will never match again and is dead weight. Nothing on the request path reads
 * it, so pruning is maintenance rather than a correctness concern — which is exactly why
 * DELETE is permitted on this table and on almost nothing else.
 */
export async function pruneRateLimits(olderThanHours = 24): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const rows = await db
    .delete(rateLimitBuckets)
    .where(sql`${rateLimitBuckets.windowStart} < ${cutoff.toISOString()}::timestamptz`)
    .returning({ key: rateLimitBuckets.bucketKey });
  return rows.length;
}
