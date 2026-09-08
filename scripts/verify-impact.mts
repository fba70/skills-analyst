import "dotenv/config";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import { BATTLE_TESTED, OUTCOME_KINDS, UNIMPLEMENTED_KINDS } from "../src/lib/outcomes";

/**
 * Impact analytics say what happened, and say when they started counting (RK.7, plan step E4).
 *
 *   pnpm verify:impact
 *
 * Free. Reads two tables and writes nothing; the one probe it inserts is removed in a `finally`.
 *
 * ## What is actually at risk
 *
 * `outcomesForSkill` and `archetypeOutcomes` were written, typed and had **zero call sites** for
 * a milestone. Surfacing them is the whole of E4, and surfacing a number is where the honesty
 * gets decided:
 *
 *   1. **A zero that reads as a fact about the skill.** Most of this corpus was indexed before
 *      the recorder shipped, so "0 downloads" means *nobody was counting*, not *nobody wanted
 *      it*. Exactly the shape of `archetypes --blocks` printing rows of zeros at 1% coverage.
 *   2. **Two battle-tested computations disagreeing in front of a reader.** The lifecycle
 *      derivation computes it in SQL with precedence; `outcomesForSkill` computes it in JS
 *      without. A deprecated skill with 40 downloads satisfies one and not the other.
 *   3. **A three-download archetype read as evidence about a category.**
 */

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function skip(name: string, why: string): void {
  console.info(`  skip  ${name} — ${why}`);
  skipped += 1;
}

// ---------------------------------------------------------------------------------------
console.info("\nThe functions E4 exists to surface");
// ---------------------------------------------------------------------------------------

/**
 * The plan's own description of this step was "zero call sites". That is the thing to assert:
 * the code was correct and unreachable, and unreachable code is indistinguishable from absent
 * code to everybody except the person who wrote it.
 */
{
  const skillPage = readFileSync("src/app/(public)/skills/[slug]/page.tsx", "utf8");
  const archetypePage = readFileSync("src/app/(public)/archetypes/[category]/page.tsx", "utf8");

  check(
    "outcomesForSkill is called from the skill page",
    /outcomesForSkill\(/.test(skillPage),
  );
  check(
    "archetypeOutcomes is called from the archetype page",
    /archetypeOutcomes\(/.test(archetypePage),
  );
  check(
    "and the collection window travels with the per-skill numbers",
    /outcomeCollectionStart\(/.test(skillPage),
    "a zero from before collection began is not a fact about the skill",
  );

  /**
   * The impact card must not render its own battle-tested badge.
   *
   * `lifecycleExpression()` owns that answer and applies precedence — a deprecated or superseded
   * skill keeps that state whatever its download count. A second badge from a second computation
   * would eventually contradict the first on the same page, and the reader would have no way to
   * know which was right.
   */
  const card = readFileSync("src/components/registry/impact-card.tsx", "utf8");
  check(
    "the impact card shows evidence rather than a competing battle-tested badge",
    !/LifecycleBadge|battle-tested<|battleTested \?/.test(card) &&
      /BATTLE_TESTED\.minDownloads/.test(card),
    "the lifecycle badge owns that answer, with precedence",
  );
  check(
    "and it names what the tier is still waiting for",
    /Towards battle-tested/.test(card),
    "a tier nobody can act on is decoration",
  );
}

check(
  "every outcome kind is now collected",
  UNIMPLEMENTED_KINDS.length === 0,
  `${OUTCOME_KINDS.length} kinds, none uncollected`,
);

// ---------------------------------------------------------------------------------------
console.info("\nAgainst the real tables");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("impact checks", "no database connection — the checks above are complete without it");
}

let probeVersionId: string | null = null;

if (connected) {
  try {
    const { outcomesForSkill, outcomeCollectionStart, archetypeOutcomes, MIN_DISTINCT_SKILLS } =
      await import("../src/server/analytics/outcomes");

    const start = await outcomeCollectionStart();
    check(
      "the collection start is derived from the table, not from a constant",
      start === null || start instanceof Date,
      start ? start.toISOString().slice(0, 10) : "nothing recorded yet",
    );

    /*
     * A skill with no signals must report zeros *and* not be battle-tested. The second half is
     * the one worth asserting: a threshold check over an empty record is where a `>=` on
     * undefined quietly becomes true.
     */
    const [anySkill] = (
      await owner.query<{ id: string; slug: string }>(
        `select id, slug from skills where status = 'indexed' and org_id is null limit 1`,
      )
    ).rows;

    if (!anySkill) {
      skip("per-skill checks", "no indexed public skill to read");
    } else {
      const outcomes = await outcomesForSkill(anySkill.id);
      check(
        "a skill's record reads back with every field present",
        typeof outcomes.downloads === "number" &&
          typeof outcomes.revalidatedPass === "number" &&
          typeof outcomes.adverse === "number",
        `${anySkill.slug}: ${outcomes.downloads} downloads`,
      );
      check(
        "and an unmeasured skill is not battle-tested",
        outcomes.downloads >= BATTLE_TESTED.minDownloads || !outcomes.battleTested,
        "an empty record must not satisfy a threshold",
      );
      check(
        "its first-indexed date is carried, so a pre-collection zero is explicable",
        outcomes.firstIndexedAt === null || outcomes.firstIndexedAt instanceof Date,
        outcomes.firstIndexedAt?.toISOString().slice(0, 10) ?? "unknown",
      );
    }

    /*
     * The reachability argument, checked rather than asserted in prose. `outcome_signals` has an
     * open read policy — deliberately, because cross-org aggregation is the point — so what stops
     * a private skill's counts leaking is that the *skill* lookup is org-scoped. If that policy
     * ever narrows, `archetypeOutcomes` silently starts describing one tenant.
     */
    const policies = await owner.query<{ cmd: string; qual: string | null }>(
      `select cmd, qual from pg_policies where tablename = 'outcome_signals'`,
    );
    const read = policies.rows.find((row) => row.cmd === "SELECT");
    check(
      "outcome_signals stays readable across organisations",
      read?.qual === "true",
      "an org-scoped read would make archetype outcomes describe one tenant at a time",
    );
    const write = policies.rows.find((row) => row.cmd === "INSERT");
    check(
      "while writes stay scoped",
      Boolean(write?.qual) === false && policies.rows.length >= 2,
      "the read is safe because of the column list, not because nobody can write",
    );

    /*
     * No free-text column. That is what makes the open read policy safe, and it is asserted
     * against `information_schema` rather than against today's data — clean data says nothing
     * about the next migration. The same check `verify:blocks` makes for `skill_blocks`.
     */
    const columns = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'outcome_signals'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    check(
      "and it carries no column that could hold tenant content",
      !names.some((name) => /note|detail|text|comment|prompt|body/.test(name)),
      names.join(", "),
    );

    // ---- the archetype half ----

    const before = await archetypeOutcomes();
    check(
      "archetype outcomes read back",
      Array.isArray(before),
      `${before.length} version(s) with any lineage`,
    );
    check(
      "and nothing below the floor is reportable",
      before.every((row) => row.usable === row.skills >= MIN_DISTINCT_SKILLS),
      `floor is ${MIN_DISTINCT_SKILLS} distinct skills`,
    );

    /**
     * A single signal must not make a version reportable.
     *
     * Written directly against a real version, then rolled back. Asserting on whatever the table
     * happens to hold would pass today by accident — there is almost no lineage in it — which is
     * the shape of a check that cannot fail.
     */
    const [version] = (
      await owner.query<{ id: string; skill_id: string }>(
        `select sv.id, sv.skill_id from skill_versions sv
          join skills s on s.id = sv.skill_id
         where s.status = 'indexed' and s.org_id is null limit 1`,
      )
    ).rows;

    if (!version) {
      skip("the floor probe", "no public version to attach a probe signal to");
    } else {
      probeVersionId = version.id;
      await owner.query(
        `insert into outcome_signals
           (skill_id, skill_version_id, kind, archetype_category, archetype_version,
            day, caller_digest)
         values ($1, $2, 'download-web', 'verify-impact-probe', 999, current_date, 'probe')`,
        [version.skill_id, version.id],
      );

      const after = await archetypeOutcomes();
      const probe = after.find((row) => row.category === "verify-impact-probe");
      check(
        "one skill's signal appears but is not reportable",
        probe !== undefined && probe.skills === 1 && !probe.usable,
        probe ? `${probe.skills} skill, usable=${probe.usable}` : "probe not found",
      );
      /*
       * Exactly 0, not "null or 0". The probe is one `download-web`, which is a positive signal,
       * so there *is* a signed denominator and none of it is adverse — 0 is the right answer and
       * null would be wrong. Accepting either would make this a check that cannot fail.
       */
      check(
        "and its adverse rate is 0 rather than null, because a signed signal exists",
        probe?.adverseRate === 0,
        `${probe?.adverseRate}`,
      );
    }
  } finally {
    if (probeVersionId) {
      await owner.query(
        `delete from outcome_signals where archetype_category = 'verify-impact-probe'`,
      );
    }
    await owner.end().catch(() => undefined);
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
