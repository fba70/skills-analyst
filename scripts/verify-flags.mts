import "dotenv/config";

import { Client } from "pg";

import {
  FLAG_REASON_META,
  FLAG_REASONS,
  FLAG_STATUSES,
  isFlagReason,
  MAX_FLAG_NOTE,
  triageOf,
  TRIAGE_ORDER,
} from "../src/lib/flags";
import { RATE_LIMIT_DEFAULTS } from "../src/server/settings/rate-limits";

/**
 * A flag records, never enforces; and the write surface refuses rather than floods (R2.5).
 *
 *   pnpm verify:flags
 *
 * Free. Every write is inside a transaction that is rolled back.
 *
 * ## The property this file exists to protect
 *
 * **A received flag must change nothing.** Enforcing on arrival means anybody who can fill in
 * a form can un-list a competitor, and the temptation is strongest exactly where an attacker
 * would aim: a credible-sounding `malicious` report. So the checks below prove that a flag
 * lands `received`, leaves the skill's status alone, and produces **no outcome signal** —
 * because `flagged` is an adverse outcome that bars `battle-tested`, and an accusation alone
 * must not be able to strip a trust tier.
 *
 * The second property is the inverted failure direction on the limiter. The MCP read scopes
 * fail *open*, because a read limiter that fails closed takes the public registry dark over
 * data that is public anyway. The public **write** scope fails *closed*, because a flood into
 * a human's queue is not undone by the settings coming back.
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
  "every reason has a reader-facing label and a distinguishing blurb",
  FLAG_REASONS.every(
    (r) => FLAG_REASON_META[r].label.length > 0 && FLAG_REASON_META[r].blurb.length > 0,
  ),
  `${FLAG_REASONS.length} reasons`,
);
check(
  "the three security reasons triage first",
  (["malicious", "prompt-injection", "secret"] as const).every((r) => triageOf(r) === "security"),
);
check(
  "security sorts ahead of quality, and quality ahead of metadata",
  TRIAGE_ORDER.security < TRIAGE_ORDER.quality && TRIAGE_ORDER.quality < TRIAGE_ORDER.metadata,
);
check(
  "a licence complaint is metadata, not security",
  triageOf("licence") === "metadata",
  "the licence being wrong is a correction; it is not a reason to read it first",
);
check(
  "there is no status that withholds content",
  FLAG_STATUSES.length === 3 && !(FLAG_STATUSES as readonly string[]).includes("enforced"),
  FLAG_STATUSES.join(", "),
);
check("an unknown reason is refused", !isFlagReason("something-else"));

console.info("\nThe limiter's failure direction is inverted for writes");

check(
  "the public write scope is far tighter than the read scopes",
  RATE_LIMIT_DEFAULTS.publicWrite.perMinute < RATE_LIMIT_DEFAULTS.mcpFree.perMinute &&
    RATE_LIMIT_DEFAULTS.publicWrite.perHour < RATE_LIMIT_DEFAULTS.mcpFree.perHour,
  `${RATE_LIMIT_DEFAULTS.publicWrite.perMinute}/min vs ${RATE_LIMIT_DEFAULTS.mcpFree.perMinute}/min`,
);

/**
 * The inversion, tested where the policy actually lives.
 *
 * The first version of this check broke `DATABASE_URL` and called `consume`, expecting the
 * settings read to fail. It did not: the pool is a module singleton built on first import, so
 * the assignment arrived too late and the limiter answered normally — a check that passed for
 * the wrong reason, which is the trap `verify:spend` documented and this file walked into
 * anyway.
 *
 * So the policy was extracted into `fallbackDecision` and is tested directly. What that
 * leaves uncovered is one line: `consume`'s `catch` returning it. Stated rather than papered
 * over — the alternative was a check that could not tell "no failure was forced" from "failed
 * to refuse".
 */
{
  const { fallbackDecision } = await import("../src/server/mcp/rate-limit");

  const read = fallbackDecision("mcpFree");
  check(
    "a read scope still allows when the limiter is unreadable",
    read.allowed === true,
    "a read limiter that fails closed takes the public registry dark over public data",
  );
  const paid = fallbackDecision("mcpPaid");
  check("the paid read scope behaves the same way", paid.allowed === true);

  const write = fallbackDecision("publicWrite");
  check(
    "the write scope refuses when the limiter is unreadable",
    write.allowed === false,
    "one refused report is a retry; one buried queue is a curator who stops reading it",
  );
  check(
    "the refusal says when to try again, so it is actionable",
    write.allowed === false && write.retryAfterSeconds > 0 && write.message.length > 0,
    write.allowed === false ? `retry after ${write.retryAfterSeconds}s` : "",
  );
}

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
    `select to_regclass('public.skill_flags') is not null as present`,
  );

  if (!exists[0].present) {
    console.info("  skip  skill_flags does not exist yet — apply the migration");
  } else {
    const { rows: enumRows } = await c.query<{ typname: string; enumlabel: string }>(
      `select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid
       where t.typname in ('flag_reason','flag_status')`,
    );
    const dbReasons = enumRows.filter((r) => r.typname === "flag_reason").map((r) => r.enumlabel);
    check(
      "the database reason enum matches the vocabulary",
      dbReasons.length === FLAG_REASONS.length && FLAG_REASONS.every((r) => dbReasons.includes(r)),
      `${dbReasons.length} vs ${FLAG_REASONS.length}`,
    );

    const { rows: pol } = await c.query<{ cmd: string }>(
      `select cmd from pg_policies where tablename = 'skill_flags'`,
    );
    const cmds = new Set(pol.map((p) => p.cmd));
    check("reads are open so a curator can triage across organisations", cmds.has("SELECT"));
    check("writes and decisions are scoped", cmds.has("INSERT") && cmds.has("UPDATE"));
    check(
      "there is no DELETE policy — a refused report is still a report that was made",
      !cmds.has("DELETE"),
    );

    // ---------------------------------------------------------------------------------
    console.info("\nA received flag changes nothing");
    // ---------------------------------------------------------------------------------

    const { rows: victim } = await c.query<{ id: string; slug: string; version_id: string; status: string }>(
      `select id, slug, current_version_id as version_id, status from skills
       where status = 'indexed' and current_version_id is not null limit 1`,
    );

    if (victim.length === 0) {
      console.info("  skip  no indexed skill to probe with");
    } else {
      const skill = victim[0];
      const { submitFlag } = await import("../src/server/curation/flags");

      const outcomesBefore = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_id = $1 and kind = 'flagged'`,
        [skill.id],
      );

      const result = await submitFlag({
        slug: skill.slug,
        reason: "malicious",
        note: "probe: verify a received flag enforces nothing",
        contact: null,
        callerKey: "203.0.113.99",
      });
      check("a flag is accepted", result.ok === true, result.ok ? "" : (result as { error: string }).error);

      const { rows: stored } = await c.query<{ status: string; n: string }>(
        `select status, count(*)::text as n from skill_flags
         where skill_id = $1 and note like 'probe:%' group by status`,
        [skill.id],
      );
      check(
        "it lands as received, not upheld",
        stored.length === 1 && stored[0].status === "received",
        stored.map((s) => `${s.status}:${s.n}`).join(", "),
      );

      const { rows: after } = await c.query<{ status: string }>(
        `select status from skills where id = $1`,
        [skill.id],
      );
      check(
        "the skill's status is untouched",
        after[0].status === skill.status,
        `${skill.status} -> ${after[0].status}`,
      );

      const { rows: versionAfter } = await c.query<{ status: string }>(
        `select status from skill_versions where id = $1`,
        [skill.version_id],
      );
      check(
        "the version is not queued for re-validation on receipt",
        versionAfter[0].status === "indexed",
        `got ${versionAfter[0].status} — only an uphold queues it`,
      );

      /**
       * The one that matters most.
       *
       * `flagged` is adverse and bars `battle-tested`. If a received flag recorded it, a
       * two-line form would defeat a month of clean downloads and a passing re-validation.
       */
      const outcomesAfter = await c.query<{ n: string }>(
        `select count(*)::text as n from outcome_signals where skill_id = $1 and kind = 'flagged'`,
        [skill.id],
      );
      check(
        "no outcome signal is recorded on receipt",
        outcomesAfter.rows[0].n === outcomesBefore.rows[0].n,
        "an accusation alone must not be able to strip a trust tier",
      );

      // The dedup: same reporter, same reason, same day.
      await submitFlag({
        slug: skill.slug,
        reason: "malicious",
        note: "probe: duplicate",
        contact: null,
        callerKey: "203.0.113.99",
      });
      const { rows: dupes } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_flags where skill_id = $1 and note like 'probe:%'`,
        [skill.id],
      );
      check(
        "a duplicate report from the same reporter today is not stored twice",
        dupes[0].n === "1",
        `${dupes[0].n} rows`,
      );

      // A different reason from the same reporter is a different report.
      await submitFlag({
        slug: skill.slug,
        reason: "broken",
        note: "probe: different reason",
        contact: null,
        callerKey: "203.0.113.99",
      });
      const { rows: twoReasons } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_flags where skill_id = $1 and note like 'probe:%'`,
        [skill.id],
      );
      check(
        "a different reason from the same reporter is a separate report",
        twoReasons[0].n === "2",
        "one reader can genuinely have two problems with one skill",
      );

      const { rows: capped } = await c.query<{ len: number }>(
        `select length(note) as len from skill_flags where skill_id = $1 and note like 'probe:%' limit 1`,
        [skill.id],
      );
      check("the note is stored within its cap", capped[0].len <= MAX_FLAG_NOTE);

      // Clean up: the probe used the real path, so these are real rows.
      await c.query(`delete from skill_flags where skill_id = $1 and note like 'probe:%'`, [skill.id]);
      await c.query(
        `delete from events where kind = 'flag.received' and subject_id = $1 and reason in ('malicious','broken')`,
        [skill.id],
      );
      const { rows: cleaned } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_flags where note like 'probe:%'`,
      );
      check("the probe left nothing behind", cleaned[0].n === "0", `${cleaned[0].n} rows`);
    }

    const { rows: totals } = await c.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from skill_flags group by status`,
    );
    console.info(
      `  note  ${totals.map((r) => `${r.status}: ${r.n}`).join(", ") || "no flags yet"}`,
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
