import "dotenv/config";

import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { platformSettings } from "../src/server/db/schema/settings";
import { user } from "../src/server/db/schema/auth";
import {
  getSchedule,
  SCHEDULE_DEFAULTS,
  setSchedule,
  stageDue,
} from "../src/server/settings/schedule";

/**
 * Proves the scheduler's configuration behaves (Doc 2 R1.7, G2; Doc 3 "cadence is data").
 *
 *   pnpm verify:schedule
 *
 * Free — no model call, no network. This is a control that decides whether the platform
 * fetches anything at all, so the properties worth checking are the ones where a mistake is
 * expensive and silent:
 *
 *   1. an **absent** row means the documented defaults, not `undefined` — the table is
 *      empty on a fresh deployment, and a reader that guessed `enabled` would start
 *      fetching before anyone configured it;
 *   2. archetype refresh defaults to **off**, because it rewrites published guidance;
 *   3. a partial write does not switch off a knob it never mentioned;
 *   4. values are clamped, so a typo cannot make the scheduler hammer or hibernate;
 *   5. a disabled stage is never due, whatever the interval says;
 *   6. every change is auditable.
 *
 * The real settings row is saved and restored, so running this does not reconfigure a live
 * scheduler.
 */

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const [actor] = await db.select({ id: user.id, email: user.email }).from(user).limit(1);
if (!actor) {
  console.info("\n  No user yet — sign in once, then re-run.\n");
  process.exit(1);
}

/**
 * Preserve whatever is configured now, and restore it through the **owner** connection.
 *
 * `platform_settings` has SELECT, INSERT and UPDATE policies and no DELETE — a setting is
 * changed, never removed, because deleting a row silently restores a default and that is
 * the one transition an operator would not expect. The consequence is that an
 * `app_runtime` delete is refused *silently*, which is how the first version of this script
 * left the live scheduler holding its own clamp-test values: one hour, twenty-five sources,
 * ten skills a source.
 *
 * So the fresh-deployment case is simulated, and undone, where maintenance belongs.
 */
const owner = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const clearRow = () => owner.query("delete from platform_settings where key = 'schedule'");

const [existing] = await db
  .select({ value: platformSettings.value })
  .from(platformSettings)
  .where(eq(platformSettings.key, "schedule"))
  .limit(1);
const savedRow = existing?.value ?? null;

// --- An absent row means the documented defaults ------------------------------
{
  await clearRow();
  const fresh = await getSchedule();

  check(
    "an unconfigured deployment gets the documented defaults, not undefined",
    fresh.pipeline.sourcesPerPass === SCHEDULE_DEFAULTS.pipeline.sourcesPerPass &&
      fresh.pipeline.maxSkillsPerSource === SCHEDULE_DEFAULTS.pipeline.maxSkillsPerSource,
    JSON.stringify(fresh.pipeline),
  );

  /**
   * The one default that must not drift.
   *
   * Mining is free, which is exactly why it is tempting to leave on — but it republishes
   * the guidance every future draft is scaffolded from, and this project has not yet
   * watched it run once at this corpus size.
   */
  check(
    "archetype refresh is OFF by default",
    fresh.archetypes.enabled === false,
    `enabled=${fresh.archetypes.enabled}`,
  );
  check(
    "the ingestion pipeline is on by default",
    fresh.pipeline.enabled === true,
    `enabled=${fresh.pipeline.enabled}`,
  );
}

// --- A partial write does not silently unset the rest -------------------------
{
  // Simulates a row written before a knob existed.
  await db
    .insert(platformSettings)
    .values({ key: "schedule", value: { pipeline: { enabled: false } } })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: { pipeline: { enabled: false } } },
    });

  const merged = await getSchedule();
  check(
    "a partial row keeps the defaults for everything it does not mention",
    merged.pipeline.enabled === false &&
      merged.pipeline.sourcesPerPass === SCHEDULE_DEFAULTS.pipeline.sourcesPerPass &&
      merged.archetypes.everyHours === SCHEDULE_DEFAULTS.archetypes.everyHours,
    JSON.stringify(merged),
  );
}

// --- Values are clamped -------------------------------------------------------
{
  const saved = await setSchedule(
    {
      pipeline: {
        enabled: true,
        everyHours: 0,
        sourcesPerPass: 9999,
        maxSkillsPerSource: 1,
      },
      archetypes: { enabled: false, everyHours: 100_000 },
    },
    { userId: actor.id, email: actor.email },
  );

  check(
    "absurd values are clamped rather than stored",
    saved.pipeline.everyHours >= 1 &&
      saved.pipeline.sourcesPerPass <= 25 &&
      saved.pipeline.maxSkillsPerSource >= 10 &&
      saved.archetypes.everyHours <= 24 * 30,
    JSON.stringify(saved),
  );
}

// --- A disabled stage is never due --------------------------------------------
{
  const schedule = await getSchedule();
  const off = await stageDue("archetypes", {
    ...schedule,
    archetypes: { enabled: false, everyHours: 1 },
  });
  check(
    "a switched-off stage is never due, whatever the interval says",
    off.due === false && off.enabled === false,
    `due=${off.due}, enabled=${off.enabled}`,
  );

  /**
   * A stage that has never run is due immediately.
   *
   * The alternative — waiting one interval before the first run — means a freshly enabled
   * weekly job does nothing for a week and looks broken.
   */
  const never = await stageDue("archetypes", {
    ...schedule,
    // A kind no run has ever written, standing in for "never run".
    archetypes: { enabled: true, everyHours: 168 },
  });
  check(
    "an enabled stage reports a due decision with a reason",
    typeof never.due === "boolean" && never.reason.length > 0,
    `due=${never.due}, reason="${never.reason}"`,
  );
}

// --- Every change is auditable ------------------------------------------------
{
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sql`events`)
    .where(sql`kind = 'schedule.changed' and at > now() - interval '2 minutes'`);
  check(
    "changing the schedule writes an audit event naming what moved",
    row.n > 0,
    `${row.n} schedule.changed events`,
  );
}

// Restore exactly what was configured before this run — including "nothing".
if (savedRow) {
  await db
    .insert(platformSettings)
    .values({ key: "schedule", value: savedRow })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: savedRow } });
} else {
  await clearRow();
}
await owner.query(
  "delete from events where kind = 'schedule.changed' and at > now() - interval '2 minutes'",
);
await owner.end();

const after = await getSchedule();
check(
  "the live schedule is left exactly as it was found",
  JSON.stringify(after) ===
    JSON.stringify(
      savedRow
        ? {
            pipeline: { ...SCHEDULE_DEFAULTS.pipeline, ...(savedRow as never as { pipeline?: object }).pipeline },
            archetypes: {
              ...SCHEDULE_DEFAULTS.archetypes,
              ...(savedRow as never as { archetypes?: object }).archetypes,
            },
          }
        : SCHEDULE_DEFAULTS,
    ),
  JSON.stringify(after),
);

console.info(failures === 0 ? "\nSchedule settings verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
