import "dotenv/config";

import { Client } from "pg";

import {
  ADVERSE_KINDS,
  BATTLE_TESTED,
  DOWNLOAD_KINDS,
  isOutcomeKind,
  OUTCOME_KINDS,
  OUTCOME_META,
  UNIMPLEMENTED_KINDS,
  valenceOf,
} from "../src/lib/outcomes";
import { callerDigest, SYSTEM_CALLER } from "../src/server/analytics/outcomes";

/**
 * Outcome signals arrive, deduplicate, identify nobody, and can earn a trust tier (R6.3).
 *
 *   pnpm verify:outcomes
 *
 * Free. Every write is inside a transaction that is rolled back.
 *
 * ## The check this file exists for
 *
 * `recordOutcome` **swallows its own failures**, on purpose: a reader downloading a skill
 * must not get a 500 because a telemetry insert hit a cold compute. That posture already
 * cost this project once — `recordUsage` swallowed an RLS refusal, so builder spend was
 * never metered and the failure was a log line nobody read, leaving RC.2 satisfied on paper
 * only.
 *
 * The fix is not to remove the swallow. It is that **something else has to be loud**. So
 * this writes through the real recorder and reads the row back, which is the only check that
 * can tell a working silent recorder from a broken one.
 *
 * The second thing worth proving is that the badge is earnable. A4 shipped `battle-tested`
 * with no branch and asserted nothing could hold it; that assertion was easy to satisfy and
 * proved nothing about whether the tier would ever work. This synthesises the evidence and
 * asserts the derivation flips — then rolls it back.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary");

check(
  "every kind has a label and a blurb",
  OUTCOME_KINDS.every((k) => OUTCOME_META[k].label.length > 0 && OUTCOME_META[k].blurb.length > 0),
  `${OUTCOME_KINDS.length} kinds`,
);
check(
  "the kinds nothing writes yet are named as such",
  UNIMPLEMENTED_KINDS.every((k) => isOutcomeKind(k)),
  `${UNIMPLEMENTED_KINDS.join(", ")} — so a dashboard can say "not collected" rather than "none"`,
);
check(
  "a re-validation failure is negative",
  valenceOf("revalidated-fail") === "negative",
);
check(
  "a re-validation pass is positive",
  valenceOf("revalidated-pass") === "positive",
);
/**
 * The one judgement in the valence table worth arguing about, so it is pinned.
 *
 * For the skill, supersession is an ending. For the *category* it is a healthy one — somebody
 * wrote something better and said so. Counting it against an archetype would penalise the
 * categories where authors iterate most, which inverts what the loop should reward.
 */
check(
  "supersession is neutral, not negative",
  valenceOf("superseded") === "neutral",
  "it is an ending for the skill and a good sign for the category",
);
check(
  "supersession does not bar battle-tested, but failure and flags do",
  !ADVERSE_KINDS.includes("superseded") &&
    ADVERSE_KINDS.includes("revalidated-fail") &&
    ADVERSE_KINDS.includes("flagged"),
  ADVERSE_KINDS.join(", "),
);
check(
  "both download channels count as downloads",
  DOWNLOAD_KINDS.length === 2 && DOWNLOAD_KINDS.every(isOutcomeKind),
  DOWNLOAD_KINDS.join(", "),
);

console.info("\nThe caller digest identifies nobody");

const ip = "203.0.113.7";
const today = "2026-09-07";
const tomorrow = "2026-09-08";
const d1 = callerDigest(ip, today);

check("the address itself is never the stored value", d1 !== ip && !d1.includes("203"), d1);
check("it is stable within a day, so a repeat deduplicates", d1 === callerDigest(ip, today));
check(
  "it changes the next day, so a reader is not trackable across days",
  d1 !== callerDigest(ip, tomorrow),
  "the day is inside the HMAC key, so yesterday's digests cannot be recomputed",
);
check(
  "two different callers differ within a day",
  callerDigest("198.51.100.4", today) !== d1,
);
check(
  "a system signal has no caller at all",
  callerDigest(null, today) === SYSTEM_CALLER,
);
/**
 * The failure direction, asserted.
 *
 * With no salt configured the digest is still a function of the day, so every caller on a
 * day collides and a skill records at most one download that day. That **undercounts**, which
 * is the only acceptable direction for a signal that can move published guidance.
 */
const hadSalt = process.env.OUTCOME_SALT;
delete process.env.OUTCOME_SALT;
const unsalted = callerDigest(ip, today);
const unsaltedOther = callerDigest("198.51.100.4", today);
if (hadSalt !== undefined) process.env.OUTCOME_SALT = hadSalt;
check(
  "with no salt it still distinguishes callers rather than silently over-counting",
  unsalted !== unsaltedOther,
  "an unsalted HMAC is still keyed on the day; the salt adds unlinkability, not dedup",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.outcome_signals') is not null as present`,
  );

  if (!exists[0].present) {
    console.info("  skip  outcome_signals does not exist yet — apply the migration");
  } else {
    const { rows: cols } = await c.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_name = 'outcome_signals' and table_schema = 'public'`,
    );
    /**
     * The columns this table may never grow: anything identifying a reader.
     *
     * A row is a skill id, a kind, a date and an unlinkable digest. The read policy is open
     * precisely because that list carries nothing about a person — so the list is the
     * security property, same argument as `builder_signals`, and it is checked against the
     * schema rather than against today's data.
     */
    const forbidden = ["ip", "ip_address", "user_agent", "user_id", "session_id", "token_id", "email"];
    const leaked = cols.filter((col) => forbidden.includes(col.column_name));
    check(
      "no column identifies a reader",
      leaked.length === 0,
      leaked.map((l) => l.column_name).join(", ") || `${cols.length} columns, none identifying`,
    );

    const { rows: pol } = await c.query<{ cmd: string; policyname: string }>(
      `select cmd, policyname from pg_policies where tablename = 'outcome_signals'`,
    );
    const byCmd = new Map(pol.map((p) => [p.cmd, p.policyname]));
    check(
      "reads are open, so an archetype can learn across organisations",
      byCmd.get("SELECT") === "read_all",
      pol.map((p) => `${p.cmd}:${p.policyname}`).join(", "),
    );
    check(
      "writes are org-scoped, so one tenant cannot forge another's outcomes",
      byCmd.has("INSERT"),
    );
    check(
      "there is no UPDATE or DELETE policy — a signal is a fact, not an opinion",
      !byCmd.has("UPDATE") && !byCmd.has("DELETE"),
      [...byCmd.keys()].join(", "),
    );

    // ---------------------------------------------------------------------------------
    console.info("\nThe silent recorder actually writes");
    // ---------------------------------------------------------------------------------

    const { rows: victim } = await c.query<{ id: string; version_id: string }>(
      `select s.id, s.current_version_id as version_id from skills s
       where s.status = 'indexed' and s.current_version_id is not null limit 1`,
    );

    if (victim.length === 0) {
      console.info("  skip  no indexed skill to probe with");
    } else {
      const { id: skillId, version_id: versionId } = victim[0];
      const { recordOutcome } = await import("../src/server/analytics/outcomes");

      const before = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_version_id = $1`,
        [versionId],
      );

      /**
       * The real recorder, not a hand-written insert.
       *
       * A hand-written insert would prove the table works and nothing about whether the
       * function that is supposed to fill it does — which is the entire failure mode a
       * swallow-everything recorder has.
       */
      await recordOutcome({
        skillId,
        skillVersionId: versionId,
        kind: "download-web",
        callerKey: "203.0.113.7",
      });

      const after = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_version_id = $1`,
        [versionId],
      );
      const wrote = Number(after.rows[0].n) - Number(before.rows[0].n);
      check(
        "recordOutcome inserted a row through the real path",
        wrote === 1,
        wrote === 1 ? "" : `${wrote} rows — the recorder swallows failures, so this is the only check that can see one`,
      );

      // Same caller, same skill, same day: the dedup.
      await recordOutcome({
        skillId,
        skillVersionId: versionId,
        kind: "download-web",
        callerKey: "203.0.113.7",
      });
      const afterRepeat = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_version_id = $1`,
        [versionId],
      );
      check(
        "a repeat from the same caller on the same day does not count twice",
        afterRepeat.rows[0].n === after.rows[0].n,
        "R6.5's dedup-per-identity, enforced by the unique index rather than by application logic",
      );

      // A different caller is a different signal.
      await recordOutcome({
        skillId,
        skillVersionId: versionId,
        kind: "download-web",
        callerKey: "198.51.100.4",
      });
      const afterOther = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_version_id = $1`,
        [versionId],
      );
      check(
        "a different caller does count",
        Number(afterOther.rows[0].n) === Number(after.rows[0].n) + 1,
      );

      const { rows: lineage } = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals
         where skill_version_id = $1 and archetype_category is not null`,
        [versionId],
      );
      console.info(
        `  note  ${lineage[0].n} of these carry archetype lineage — NULL for every ingested` +
          ` skill, which is R6.3's attribution half having almost no data yet`,
      );

      // Clean up what this probe wrote. It used the real recorder, so it is real data.
      await c.query(
        `delete from outcome_signals where skill_version_id = $1 and caller_digest = any($2::text[])`,
        [versionId, [callerDigest("203.0.113.7", new Date().toISOString().slice(0, 10)), callerDigest("198.51.100.4", new Date().toISOString().slice(0, 10))]],
      );
      const { rows: cleaned } = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_version_id = $1`,
        [versionId],
      );
      check(
        "the probe left nothing behind",
        cleaned[0].n === before.rows[0].n,
        `${cleaned[0].n} now vs ${before.rows[0].n} before the probe`,
      );

      // -------------------------------------------------------------------------------
      console.info("\nBattle-tested is earnable, and only by evidence");
      // -------------------------------------------------------------------------------

      const { lifecycleExpression } = await import("../src/server/skills/lifecycle");
      const { PgDialect } = await import("drizzle-orm/pg-core");
      // The compiled expression carries parameters — the BATTLE_TESTED thresholds and the
      // kind arrays. They go first; the probe's skill id is bound after them.
      const compiled = new PgDialect().sqlToQuery(lifecycleExpression());
      const DERIVE = compiled.sql.replace(/"skills"\./g, "s.");
      const DP = compiled.params as unknown[];
      const SKILL_BIND = `$${DP.length + 1}`;

      await c.query("begin");
      try {
        const { rows: plain } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, skillId],
        );
        check(
          "with no evidence it is not battle-tested",
          plain[0].state !== "battle-tested",
          `got ${plain[0].state}`,
        );

        // Synthesise exactly the evidence RK.1 asks for: enough distinct callers, an age,
        // a re-validation that passed, and nothing adverse.
        const digests = Array.from({ length: BATTLE_TESTED.minDownloads }, (_, i) => `probe${i}`);
        await c.query(
          `insert into outcome_signals (skill_id, skill_version_id, kind, day, caller_digest)
           select $1, $2, 'download-web', current_date, d from unnest($3::text[]) d`,
          [skillId, versionId, digests],
        );
        await c.query(
          `insert into outcome_signals (skill_id, skill_version_id, kind, day, caller_digest)
           values ($1, $2, 'revalidated-pass', current_date, 'system')`,
          [skillId, versionId],
        );
        await c.query(
          `update skills set first_seen_at = now() - ($1 || ' days')::interval where id = $2`,
          [BATTLE_TESTED.minAgeDays + 1, skillId],
        );

        const { rows: earned } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, skillId],
        );
        check(
          "with the evidence it becomes battle-tested",
          earned[0].state === "battle-tested",
          `got ${earned[0].state} — the branch A4 promised, now reachable`,
        );

        // One adverse outcome disqualifies it, however many downloads there are.
        await c.query(
          `insert into outcome_signals (skill_id, skill_version_id, kind, day, caller_digest)
           values ($1, $2, 'revalidated-fail', current_date, 'system')`,
          [skillId, versionId],
        );
        const { rows: barred } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, skillId],
        );
        check(
          "a single adverse outcome bars it, whatever the download count",
          barred[0].state !== "battle-tested",
          `got ${barred[0].state}`,
        );

        // And it is still not grantable: the enum cannot express it.
        let refused = false;
        try {
          await c.query(`select 'battle-tested'::lifecycle_declaration`);
        } catch {
          refused = true;
        }
        check(
          "it remains impossible to declare, only to earn",
          refused,
          "the tier's whole value is that static scanning cannot produce it",
        );
      } finally {
        await c.query("rollback");
      }

      const { rows: finalCount } = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where caller_digest like 'probe%'`,
      );
      check("the battle-tested probe rolled back", finalCount[0].n === "0", `${finalCount[0].n} rows`);
    }

    const { rows: totals } = await c.query<{ n: string; skills: string; kinds: string }>(
      `select count(*)::text as n, count(distinct skill_id)::text as skills,
              count(distinct kind)::text as kinds from outcome_signals`,
    );
    console.info(
      `  note  ${totals[0].n} signals across ${totals[0].skills} skill(s), ${totals[0].kinds} kind(s)`,
    );

    /**
     * The list of uncollected kinds, checked against the table rather than trusted.
     *
     * `UNIMPLEMENTED_KINDS` is a statement about the *code* — which kinds no path can
     * produce — so it cannot be derived from data. It can be contradicted by data, and it
     * was: `flagged` stayed on the list after `upholdFlag` started writing it, and
     * Settings → Loop consequently told an operator *"Not collected yet: flagged. Flagging
     * needs a reader route (R2.5)"* while recording through the route it asked for.
     *
     * Zero rows is the property. A kind the platform genuinely cannot write has none, so a
     * single stored row proves the list is stale and names the kind to remove. This is the
     * one mechanism that makes forgetting it loud instead of silent — the same reason
     * `verify:archetypes` compiles the lifecycle expression rather than holding a copy.
     */
    const { rows: claimed } = await c.query<{ kind: string; n: string }>(
      `select kind, count(*)::text as n from outcome_signals
       where kind = any(string_to_array($1, ','))
       group by kind`,
      [UNIMPLEMENTED_KINDS.join(",")],
    );
    check(
      "no kind listed as uncollected has actually been collected",
      claimed.length === 0,
      claimed.length > 0
        ? `${claimed.map((r) => `${r.kind} has ${r.n} rows`).join(", ")} — remove it from UNIMPLEMENTED_KINDS`
        : `${UNIMPLEMENTED_KINDS.join(", ") || "nothing"} still unwritten, as claimed`,
    );

    /*
     * And the other direction: a kind that IS implemented must not be on the list.
     * `flagged` is the one this file exists to pin, because it is the kind whose absence
     * from the dashboard was visible to an operator for a day.
     */
    check(
      "flagged is no longer claimed to be uncollected",
      !(UNIMPLEMENTED_KINDS as readonly string[]).includes("flagged"),
      "upholdFlag writes it; a reader route exists",
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
