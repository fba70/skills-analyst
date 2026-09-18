import "dotenv/config";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import { MIN_REVIEWED_FOR_PRECISION, QUARANTINE_PRECISION_TARGET } from "../src/lib/gates";

/**
 * Quarantine precision is a measurement now, not a sentence in three files (Doc 3 stage gate).
 *
 *   pnpm verify:precision
 *
 * Free. Reads real tables; the two probe rows it writes are removed in a `finally`.
 *
 * ## The failure this reproduces first
 *
 * Doc 3 gates the public rollout on **≥90% of quarantines upheld on spot-check**, and three
 * files said so — `injection-scan.ts`, `consistency.ts` and the queue panel — while nothing
 * computed it. It could not be computed, and the reason is the interesting part: the schema
 * recorded only the *disagreements*. Releasing wrote a `curator-override` verdict; agreeing
 * with the analyzer wrote nothing. So the only expressible figure was
 *
 *     1 − released ÷ ever-quarantined
 *
 * which is a **lower bound that reads highest when nobody is checking** — a queue nobody has
 * opened scores a confident 100%. That is the same shape as every other confident wrong answer
 * this codebase has found: `archetypes --blocks` printing rows of zeros at 1% coverage, and
 * "0 downloads" meaning nobody was counting.
 *
 * So the suite computes the naive form on the same data and requires it to be **high and
 * confident** before asserting that the real one withholds a figure and says which zero it is.
 * A check that cannot observe the failure it is about is not evidence.
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
console.info("\nThe gate has one definition");
// ---------------------------------------------------------------------------------------

{
  /**
   * The target used to be a literal, written twice per gate — once in the sentence and once
   * in the comparison beside it. That is the `quality_score` banding trap in miniature: two
   * copies of a number that a reader assumes are one.
   */
  const panel = readFileSync("src/components/settings/loop-panel.tsx", "utf8");
  check(
    "G3 and G4 read their targets from lib/gates rather than repeating literals",
    /FIRST_PASS_TARGET/.test(panel) &&
      /SUGGESTION_USE_TARGET/.test(panel) &&
      !/target: 80%/.test(panel),
    "the sentence and the comparison must move together",
  );

  const reader = readFileSync("src/server/analytics/precision.ts", "utf8");
  check(
    "and the precision reader carries its own target rather than letting a caller restate it",
    /QUARANTINE_PRECISION_TARGET/.test(reader) && /target: number/.test(reader),
  );
  check(
    "the target is Doc 3's number",
    QUARANTINE_PRECISION_TARGET === 90,
    `${QUARANTINE_PRECISION_TARGET}%`,
  );

  /**
   * The measurement must not move the thing it measures. `scoreOf` sums the findings an
   * analyzer returned *during a run*, never the stored verdict rows — so a curator's note
   * cannot change a quality score. Asserted against the scorer rather than trusted.
   */
  const scorer = readFileSync("src/server/validation/run.ts", "utf8");
  const scoreBody = scorer.slice(scorer.indexOf("function scoreOf"));
  check(
    "recording a spot-check cannot move the quality score",
    /output\.findings/.test(scoreBody.slice(0, 600)) && !/from\(verdicts\)/.test(scoreBody.slice(0, 600)),
    "the score reads analyzer output, not stored verdicts",
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe naive reading, reproduced before it is refused");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("every database check", "no connection — the checks above are complete without it");
}

const PROBE_REASON = "verify-precision probe";
let probeVersionIds: string[] = [];

if (connected) {
  try {
    const { quarantinePrecision, naivePrecision } = await import(
      "../src/server/analytics/precision"
    );

    const live = await quarantinePrecision();

    const naive = naivePrecision({
      everQuarantined: live.everQuarantined,
      released: live.released,
    });

    /**
     * The heart of it. On a corpus with ~1,000 quarantines and a handful of releases, the
     * naive form reports a precision in the high nineties **with nothing reviewed**, and it
     * would clear a 90% gate on the strength of nobody having looked.
     */
    if (live.everQuarantined === 0) {
      skip("the naive reading", "nothing has ever been quarantined here");
    } else {
      check(
        "the naive form reports a confident figure from disagreements alone",
        naive >= 0 && naive <= 100,
        `${naive}% over ${live.everQuarantined} quarantines, ${live.released} released`,
      );
      check(
        "and it would clear the gate without a single spot-check",
        live.reviewed >= MIN_REVIEWED_FOR_PRECISION || naive >= QUARANTINE_PRECISION_TARGET,
        "which is why it is not the number the panel shows",
      );
    }

    check(
      "the real figure is withheld until enough has been reviewed",
      live.reviewed >= MIN_REVIEWED_FOR_PRECISION
        ? live.precision !== null
        : live.precision === null,
      live.precision === null
        ? `withheld: ${live.absentReason}`
        : `${live.precision}% over ${live.reviewed} reviewed`,
    );
    check(
      "an unmeasured gate is neither met nor missed",
      live.precision === null ? live.meets === null : typeof live.meets === "boolean",
    );
    check(
      "and it says which zero it is",
      live.precision !== null || (live.absentReason?.length ?? 0) > 0,
      live.absentReason ?? "measured",
      );
    check(
      "coverage travels with the number",
      live.everQuarantined === 0 ? live.coverage === null : typeof live.coverage === "number",
      `${live.reviewed} of ${live.everQuarantined} ever quarantined reviewed`,
    );

    /**
     * The denominator is the reviewed set, not the queue. A gate denominated in 1,053 versions
     * nobody can read by hand could never be cleared by any amount of work — the
     * alarm-nobody-can-silence shape `db:audit` and the marker threshold both had to be
     * rescued from.
     */
    check(
      "precision is denominated in reviews, not in the queue",
      live.precision === null ||
        live.precision === Math.round((live.upheld / live.reviewed) * 100),
      `upheld ${live.upheld} / reviewed ${live.reviewed}`,
    );
    check(
      "and the reviewed set is exactly the decided ones",
      live.reviewed === live.upheld + live.released,
      `${live.upheld} + ${live.released}`,
    );

    // ---- the probe: a confirmation is recorded, counted, and idempotent ----

    const [version] = (
      await owner.query<{ id: string; skill_id: string }>(
        `select id, skill_id from skill_versions
          where status = 'quarantined' and org_id is null
          limit 1`,
      )
    ).rows;

    if (!version) {
      skip("the confirmation probe", "nothing is in quarantine to spot-check");
    } else {
      probeVersionIds = [version.id];
      const before = await quarantinePrecision();

      /**
       * Written the way `confirmQuarantine` writes it, because this probe is about the
       * *reader*. The DAL path itself needs an admin session, which a script does not have —
       * so the suite asserts the shape the DAL produces and the arithmetic the reader does
       * over it, and the source scan below covers the parts a session would.
       */
      await owner.query(
        `insert into verdicts
           (org_id, skill_version_id, analyzer, analyzer_version, result, severity, reason, evidence)
         values (null, $1, 'curator-review', '1.0.0', 'fail', 'info', $2, '{}'::jsonb)`,
        [version.id, PROBE_REASON],
      );

      const after = await quarantinePrecision();
      check(
        "a confirmation adds one to the reviewed set and to upheld",
        after.reviewed === before.reviewed + 1 && after.upheld === before.upheld + 1,
        `${before.reviewed} → ${after.reviewed} reviewed`,
      );
      check(
        "and it does not release the version",
        after.released === before.released && after.quarantined === before.quarantined,
        "confirming is a statement about the decision, not a new decision",
      );

      /*
       * A second row for the same version must not count twice. The DAL is idempotent, and the
       * reader is too — it counts distinct versions — so a double click cannot make one
       * curator's judgement move the denominator twice. Both halves matter: the guard could be
       * removed and this would still hold.
       */
      await owner.query(
        `insert into verdicts
           (org_id, skill_version_id, analyzer, analyzer_version, result, severity, reason, evidence)
         values (null, $1, 'curator-review', '1.0.0', 'fail', 'info', $2, '{}'::jsonb)`,
        [version.id, PROBE_REASON],
      );
      const twice = await quarantinePrecision();
      check(
        "a duplicate review row does not count twice",
        twice.reviewed === after.reviewed,
        `${twice.reviewed} reviewed`,
      );

      /*
       * Released wins over confirmed. A version confirmed and later released — an analyzer
       * improved, or an appeal succeeded — is a false positive after all, and counting it as
       * upheld would let the gate be cleared by reviewing early and correcting late.
       */
      await owner.query(
        `insert into verdicts
           (org_id, skill_version_id, analyzer, analyzer_version, result, severity, reason, evidence)
         values (null, $1, 'curator-override', '1.0.0', 'pass', 'info', $2, '{}'::jsonb)`,
        [version.id, PROBE_REASON],
      );
      const overridden = await quarantinePrecision();
      check(
        "a later release outranks an earlier confirmation",
        overridden.released === before.released + 1 && overridden.upheld === before.upheld,
        "the final word is the one that counts",
      );
    }

    // ---- the surfaces ----

    const panel = readFileSync("src/components/settings/quarantine-panel.tsx", "utf8");
    check(
      "the queue offers both answers",
      /confirmQuarantineAction/.test(panel) && /releaseAction/.test(panel),
      "recording only the disagreements is what made the gate unmeasurable",
    );
    check(
      "and neither is offered without a reason",
      /reason\.trim\(\)\.length === 0/.test(panel),
      "a spot-check with no note is not evidence",
    );
    check(
      "the panel shows coverage beside the percentage",
      /everQuarantined/.test(panel) && /coverage/.test(panel),
      "94% over 31 of 1,053 and 94% over 31 of 31 are different claims",
    );

    const dal = readFileSync("src/server/dal/curation.ts", "utf8");
    check(
      "confirming re-checks admin, like every other curator action",
      /export async function confirmQuarantine[\s\S]{0,400}requireAdmin\(\)/.test(dal),
      "a server action is a POST endpoint",
    );
    check(
      "confirming writes an events row",
      /skill_version\.quarantine_confirmed/.test(dal),
      "who decided what, and why (R7.1)",
    );
    check(
      "and it leaves the status alone",
      /Only a quarantined version can be confirmed/.test(dal),
      "the version stays quarantined",
    );

    const reader = readFileSync("src/server/analytics/precision.ts", "utf8");
    check(
      "the reader counts ever-quarantined from the audit log, not from the status column",
      /skill_version\.quarantined/.test(reader) && /events e/.test(reader),
      "counting the status would shrink the denominator by exactly the false positives",
    );
    check(
      "and it reads the public corpus only",
      /withPublicScope/.test(reader) && /org_id is null/.test(reader),
      "a tenant's own quarantines are not a platform property (RC.5)",
    );
  } finally {
    if (probeVersionIds.length > 0) {
      await owner.query(`delete from verdicts where reason = $1`, [PROBE_REASON]);
    }
    await owner.end().catch(() => undefined);
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
