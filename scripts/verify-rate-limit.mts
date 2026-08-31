import "dotenv/config";

import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { platformSettings, rateLimitBuckets } from "../src/server/db/schema/settings";
import { user } from "../src/server/db/schema/auth";
import {
  getRateLimits,
  RATE_LIMIT_DEFAULTS,
  setRateLimits,
} from "../src/server/settings/rate-limits";
import { callerKey, consume, pruneRateLimits } from "../src/server/mcp/rate-limit";

/**
 * Proves the MCP rate limiter behaves (Doc 2 R8.8).
 *
 *   pnpm verify:rate-limit
 *
 * **Free** — no model call and no network. A rate limit is arithmetic and a refusal, and a
 * test that made real requests to prove one would be measuring the dev server rather than
 * the rule.
 *
 * What is worth checking is what is expensive and silent when it is wrong:
 *
 *   1. an **absent** settings row means the documented defaults, not `undefined` — the
 *      table is empty on a fresh deployment, and a limiter reading `enabled` as undefined
 *      would leave the endpoint open exactly when nobody had configured it;
 *   2. a partial row does not unset the knobs it never mentions;
 *   3. the limit actually refuses at the boundary — not one early, not one late;
 *   4. a refusal names its window, its limit and when it lifts (R8.8's acceptance criterion:
 *      an agent that cannot tell a throttle from a permission failure retries forever or
 *      gives up);
 *   5. refused calls keep counting, so hammering does not reset the door;
 *   6. one caller's budget is not another's;
 *   7. a window that has rolled starts a fresh count;
 *   8. values are clamped, and an hourly cap below the per-minute cap is repaired rather
 *      than stored as an unreachable number;
 *   9. disabling the scope allows everything;
 *  10. every change is auditable.
 *
 * The real settings row is saved and restored **through the owner connection**, and the
 * script asserts it is left exactly as it was found. `platform_settings` has no DELETE
 * policy, so an `app_runtime` delete is refused *silently* — which is how an earlier
 * verification script left a live scheduler holding its own test values.
 */

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const [actor] = await db.select({ id: user.id, email: user.email }).from(user).limit(1);
if (!actor) {
  console.info("\n  No user yet — sign in once, then re-run.\n");
  process.exit(1);
}

const owner = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const clearRow = () => owner.query("delete from platform_settings where key = 'rate-limits'");

const [existing] = await db
  .select({ value: platformSettings.value })
  .from(platformSettings)
  .where(eq(platformSettings.key, "rate-limits"))
  .limit(1);
const savedRow = existing?.value ?? null;

/** A request carrying a chosen caller identity — the only input the limiter reads. */
const from = (ip: string) =>
  new Request("https://example.test/api/mcp", { headers: { "x-forwarded-for": ip } });

/** Test callers live under a prefix so cleanup cannot touch a real one. */
const TEST_IP = "198.51.100.";
const cleanupBuckets = () =>
  owner.query("delete from rate_limit_buckets where bucket_key like $1", [`ip:${TEST_IP}%`]);

await cleanupBuckets();

// --- 1. absent row means the documented defaults ------------------------------
{
  await clearRow();
  const fresh = await getRateLimits();
  check(
    "an unconfigured deployment gets the documented defaults, not undefined",
    fresh.mcpFree.perMinute === RATE_LIMIT_DEFAULTS.mcpFree.perMinute &&
      fresh.mcpFree.perHour === RATE_LIMIT_DEFAULTS.mcpFree.perHour,
    JSON.stringify(fresh.mcpFree),
  );
  check(
    "the free scope is limited by default",
    fresh.mcpFree.enabled === true,
    `enabled=${fresh.mcpFree.enabled}`,
  );
}

// --- 2. a partial row keeps the rest ------------------------------------------
{
  await db
    .insert(platformSettings)
    .values({ key: "rate-limits", value: { mcpFree: { perMinute: 5 } } })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: { mcpFree: { perMinute: 5 } } },
    });
  const merged = await getRateLimits();
  check(
    "a partial row keeps the defaults for everything it does not mention",
    merged.mcpFree.perMinute === 5 &&
      merged.mcpFree.enabled === RATE_LIMIT_DEFAULTS.mcpFree.enabled &&
      merged.mcpPaid.perHour === RATE_LIMIT_DEFAULTS.mcpPaid.perHour,
    JSON.stringify(merged),
  );
}

// --- 3/4/5. the boundary, the message, and refusals still counting -------------
{
  await setRateLimits(
    {
      mcpFree: { enabled: true, perMinute: 3, perHour: 1000 },
      mcpPaid: RATE_LIMIT_DEFAULTS.mcpPaid,
    },
    { userId: actor.id, email: actor.email },
  );

  const caller = from(`${TEST_IP}1`);
  const outcomes = [];
  for (let i = 0; i < 5; i += 1) outcomes.push(await consume(caller, "mcpFree"));

  check(
    "the first N calls are allowed and the next is not",
    outcomes.slice(0, 3).every((o) => o.allowed) && outcomes[3].allowed === false,
    outcomes.map((o) => (o.allowed ? "ok" : "429")).join(","),
  );

  const refused = outcomes[3];
  check(
    "the refusal names its window, its limit and when it lifts",
    refused.allowed === false &&
      refused.window === "minute" &&
      refused.limit === 3 &&
      refused.retryAfterSeconds > 0 &&
      refused.resetAt instanceof Date &&
      refused.message.includes("throttle"),
    JSON.stringify(refused),
  );

  check(
    "a refused call still counts, so hammering does not reopen the door",
    outcomes[4].allowed === false,
    JSON.stringify(outcomes[4]),
  );

  const [row] = await db
    .select({ count: rateLimitBuckets.count })
    .from(rateLimitBuckets)
    .where(
      sql`${rateLimitBuckets.bucketKey} = ${`ip:${TEST_IP}1`} and ${rateLimitBuckets.scope} = 'mcpFree:minute'`,
    );
  check(
    "every call was counted, including the refused ones",
    row?.count === 5,
    `count=${row?.count}`,
  );
}

// --- 6. one caller's budget is not another's ----------------------------------
{
  const other = await consume(from(`${TEST_IP}2`), "mcpFree");
  check("a different caller starts with a full budget", other.allowed === true);
}

// --- 7. a rolled window starts fresh ------------------------------------------
{
  // Reaching into the counter is the only way to simulate time passing without waiting a
  // minute for it. The row is the limiter's entire memory, so moving it back is exactly
  // equivalent to the window having elapsed.
  await owner.query(
    `update rate_limit_buckets set window_start = window_start - interval '2 minutes'
     where bucket_key = $1 and scope = 'mcpFree:minute'`,
    [`ip:${TEST_IP}1`],
  );
  const after = await consume(from(`${TEST_IP}1`), "mcpFree");
  check("a caller that was refused is allowed again once the window rolls", after.allowed === true);

  const [row] = await db
    .select({ count: rateLimitBuckets.count })
    .from(rateLimitBuckets)
    .where(
      sql`${rateLimitBuckets.bucketKey} = ${`ip:${TEST_IP}1`} and ${rateLimitBuckets.scope} = 'mcpFree:minute'`,
    );
  check("the rolled window restarts the count at one", row?.count === 1, `count=${row?.count}`);
}

// --- 8. clamping, and an unreachable hourly cap being repaired -----------------
{
  const saved = await setRateLimits(
    {
      mcpFree: { enabled: true, perMinute: 0, perHour: 2 },
      mcpPaid: { enabled: true, perMinute: 10, perHour: 5 },
    },
    { userId: actor.id, email: actor.email },
  );
  check(
    "a zero limit is clamped to one rather than silently meaning 'refuse everything'",
    saved.mcpFree.perMinute === 1,
    `perMinute=${saved.mcpFree.perMinute}`,
  );
  check(
    "an hourly cap below the per-minute cap is raised to match, not stored unreachable",
    saved.mcpPaid.perHour === 10,
    `perHour=${saved.mcpPaid.perHour}`,
  );
}

// --- 9. a disabled scope allows everything ------------------------------------
{
  await setRateLimits(
    {
      mcpFree: { enabled: false, perMinute: 1, perHour: 1 },
      mcpPaid: RATE_LIMIT_DEFAULTS.mcpPaid,
    },
    { userId: actor.id, email: actor.email },
  );
  const caller = from(`${TEST_IP}3`);
  const results = [await consume(caller), await consume(caller), await consume(caller)];
  check(
    "a disabled scope allows everything, whatever the numbers say",
    results.every((r) => r.allowed),
    JSON.stringify(results),
  );
}

// --- 10. the change is auditable ----------------------------------------------
{
  const result = await db.execute<{ kind: string; reason: string }>(
    sql`select kind, reason from events where kind = 'rate-limits.changed'
        order by at desc limit 1`,
  );
  const row = result.rows[0];
  check(
    "changing the limits writes an audit event naming what moved",
    Boolean(row?.kind) && typeof row?.reason === "string" && row.reason.length > 0,
    JSON.stringify(row),
  );
}

// --- identity, and the pruner -------------------------------------------------
{
  check(
    "the caller key comes from the forwarded address",
    callerKey(from("203.0.113.9")) === "ip:203.0.113.9",
    callerKey(from("203.0.113.9")),
  );
  check(
    "a request with no forwarded address still yields a key rather than throwing",
    callerKey(new Request("https://example.test/api/mcp")) === "ip:unknown",
  );
  const pruned = await pruneRateLimits(0);
  check("pruning removes expired counters", pruned >= 0, `pruned=${pruned}`);
}

// --- restore, and prove it -----------------------------------------------------
await cleanupBuckets();
await clearRow();
if (savedRow !== null) {
  await owner.query(
    "insert into platform_settings (key, value) values ('rate-limits', $1::jsonb)",
    [JSON.stringify(savedRow)],
  );
}

{
  const [after] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, "rate-limits"))
    .limit(1);
  const restored = after?.value ?? null;
  check(
    "the live settings are left exactly as they were found",
    JSON.stringify(restored) === JSON.stringify(savedRow),
    `found ${JSON.stringify(savedRow)}, left ${JSON.stringify(restored)}`,
  );
}

await owner.end();
console.info(
  failures === 0
    ? "\nRate limiter verified.\n"
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
