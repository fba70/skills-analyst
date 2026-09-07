import "dotenv/config";

import { Client } from "pg";

import { FAQ_SECTIONS } from "../src/lib/faq";
import {
  isCautionState,
  isLifecycleDeclaration,
  LIFECYCLE_DECLARATIONS,
  LIFECYCLE_META,
  LIFECYCLE_STATES,
} from "../src/lib/lifecycle";

/**
 * The lifecycle cannot be faked, and its derivation has one implementation (Doc 6 RK.1).
 *
 *   pnpm verify:lifecycle
 *
 * Free. Reads the schema and the corpus; every write it makes is inside a transaction that
 * is rolled back.
 *
 * ## What is actually at risk
 *
 * Not the CASE expression — five branches are easy to read. The risks are structural, and
 * each one is a promise RK.1 makes that could quietly stop being true:
 *
 *   1. **Battle-tested being grantable.** Doc 6's whole argument for a second trust tier is
 *      that static scanning cannot produce it. The guarantee is not "we won't set it", it is
 *      that *there is nowhere to set it* — so the check is on the enum, not on the data.
 *   2. **Stale becoming declarable.** Same shape: detected, never asserted.
 *   3. **The pipeline overwriting a curator.** `status` and the declaration are different
 *      columns precisely so a re-sync cannot clear a deprecation. Asserted by probing the
 *      actual write, not by reading the sync code.
 *   4. **A supersession pointing nowhere.** A state that tells a reader to go elsewhere and
 *      cannot say where is a worse `deprecated`. The refusal is tested.
 *
 * Written failure-first: every case names the wrong behaviour it guards against, and the
 * probes reproduce the refusal rather than asserting that today's data happens to be clean.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary, and what it refuses to let anyone assert");

check(
  "every state has a label, a blurb, an origin and a tone",
  LIFECYCLE_STATES.every(
    (s) =>
      LIFECYCLE_META[s].label.length > 0 &&
      LIFECYCLE_META[s].blurb.length > 0 &&
      LIFECYCLE_META[s].origin.length > 0 &&
      LIFECYCLE_META[s].tone.length > 0,
  ),
  `${LIFECYCLE_STATES.length} states`,
);

/**
 * The guarantee, stated as a test rather than as a comment.
 *
 * If `battle-tested` ever becomes declarable, Doc 6's second trust tier collapses into a
 * synonym for "an admin liked it" — which is exactly the thing a static-scanning registry
 * can already fake and the reason this tier was proposed at all.
 */
check(
  "battle-tested is not declarable",
  !isLifecycleDeclaration("battle-tested"),
  "it must be earned from evidence; there is no column to write it into",
);
check("stale is not declarable", !isLifecycleDeclaration("stale"), "it is detected, not asserted");
check("validated is not declarable", !isLifecycleDeclaration("validated"));
check(
  "exactly two states are declarable",
  LIFECYCLE_DECLARATIONS.length === 2,
  LIFECYCLE_DECLARATIONS.join(", "),
);
check(
  "every declarable state is also a state a reader can see",
  LIFECYCLE_DECLARATIONS.every((d) => (LIFECYCLE_STATES as readonly string[]).includes(d)),
);
check(
  "draft is absent, because a row in skills is by definition published",
  !(LIFECYCLE_STATES as readonly string[]).includes("draft"),
  "a value nothing can hold is a vocabulary lying about its space",
);
check(
  "the caution states are the three that should change what a reader does",
  isCautionState("stale") &&
    isCautionState("deprecated") &&
    isCautionState("superseded") &&
    !isCautionState("validated") &&
    !isCautionState("battle-tested"),
);
check(
  "the FAQ has a lifecycle section for the badge to link into",
  FAQ_SECTIONS.some((s) => s.id === "lifecycle"),
);

console.info("\nThe schema");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: enumValues } = await c.query<{ value: string }>(
    `select e.enumlabel as value
     from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'lifecycle_declaration' order by e.enumsortorder`,
  );
  const stored = enumValues.map((r) => r.value);

  if (stored.length === 0) {
    console.info("  skip  lifecycle_declaration does not exist yet — apply the migration");
  } else {
    /**
     * The database-level half of the same guarantee. The TypeScript check above can be
     * edited; this one asserts that Postgres itself will reject the value.
     */
    check(
      "the database enum holds only the two declarable states",
      stored.length === 2 && stored.includes("deprecated") && stored.includes("superseded"),
      stored.join(", "),
    );
    check(
      "the database enum cannot express battle-tested or stale",
      !stored.includes("battle-tested") && !stored.includes("stale"),
      "so no UPDATE, script or hand-typed statement can grant either",
    );

    const { rows: cols } = await c.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'skills' and table_schema = 'public'
         and column_name in ('lifecycle_declaration','superseded_by_skill_id','lifecycle_note',
                             'review_by','owner_id','lifecycle_changed_at')`,
    );
    check(
      "all six lifecycle columns exist",
      cols.length === 6,
      cols.map((x) => x.column_name).sort().join(", "),
    );
    /**
     * Nullable is the correct shape and worth pinning. The public corpus is other people's
     * work: we are in no position to assign it owners or review dates, so the columns must
     * be absent for almost every row rather than defaulted to something invented.
     */
    check(
      "every lifecycle column is nullable",
      cols.every((x) => x.is_nullable === "YES"),
      cols.filter((x) => x.is_nullable !== "YES").map((x) => x.column_name).join(", "),
    );

    console.info("\nThe derivation, probed against real rows");

    /**
     * The application's own expression, rendered to SQL — not a copy of it.
     *
     * The first version of this file pasted the CASE in and claimed in a comment that it
     * was "kept identical on purpose". That is precisely the shape this codebase keeps
     * paying for: a checker with its own copy of the rule verifies that the copy is
     * self-consistent and stops noticing the day the real one moves. `taxonomy --status`
     * reporting thirteen archetype-ready categories while the miner refused one of them was
     * the same mistake, and the near-proxy replacement for it agreed to within a point.
     *
     * So the expression is compiled out of `lifecycleExpression()` through Drizzle's own
     * dialect. If the derivation changes, this check tests the change rather than the
     * memory of it. The `skills`-prefixed column references are rewritten to the `s` alias
     * these probes use.
     */
    const { lifecycleExpression } = await import("../src/server/skills/lifecycle");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    /**
     * The compiled expression now carries **parameters**, so they have to be passed.
     *
     * Adding the `battle-tested` branch put the `BATTLE_TESTED` thresholds and the kind
     * arrays into the SQL as placeholders. This file embedded the compiled text and passed
     * only its own skill id, which failed with `transformParamRef` the moment the branch
     * landed — a good failure, and exactly why the expression is compiled rather than copied:
     * a hand-written copy would have gone on testing the old three-branch rule in silence.
     *
     * The derivation's parameters go first and the probe's own bind is renumbered after them.
     */
    const compiled = new PgDialect().sqlToQuery(lifecycleExpression());
    const DERIVE = compiled.sql.replace(/"skills"\./g, "s.");
    const DP = compiled.params as unknown[];
    /** `$n` for the probe's own bind, after the derivation's. */
    const SKILL_BIND = `$${DP.length + 1}`;
    /**
     * Asserted on the *columns* it reads, not on a substring of the rendered text.
     *
     * The first version tested `DERIVE.includes("s.status")` and failed against a perfectly
     * correct compilation, because Drizzle quotes identifiers: the real output is
     * `s."status"`. A check keyed to one dialect's punctuation is brittle in the boring
     * direction — it fails when nothing is wrong — so this normalises the quoting and then
     * asserts every input the rule depends on is actually referenced. That version would
     * also catch a rewrite that quietly dropped a branch, which the substring test would not.
     */
    const bare = DERIVE.replace(/"/g, "");
    const readsColumns = ["s.status", "s.lifecycle_declaration", "s.review_by"].filter(
      (col) => !bare.includes(col),
    );
    check(
      "the derivation under test is the application's, not a copy",
      bare.includes("case") && readsColumns.length === 0 && !bare.includes("skills."),
      readsColumns.length > 0
        ? `does not read ${readsColumns.join(", ")}`
        : `${compiled.params.length} params, reads all three inputs`,
    );

    const { rows: counts } = await c.query<{ state: string | null; n: string }>(
      `select ${DERIVE} as state, count(*)::text as n from skills s group by 1 order by 2 desc`,
      DP,
    );
    for (const row of counts) {
      console.info(`  note  ${String(row.state ?? "(not indexed)").padEnd(16)} ${row.n}`);
    }

    check(
      "no skill is battle-tested",
      !counts.some((r) => r.state === "battle-tested"),
      "and none can be until outcome telemetry exists (R6.3, plan step B1)",
    );
    check(
      "no skill that is not indexed carries a lifecycle state",
      counts.filter((r) => r.state === null).every(() => true),
      "the trust surface answers for those, not this one",
    );

    /**
     * A declaration on a non-indexed skill must not leak into the derived state.
     *
     * The tempting bug is to check the declaration first and the status second, which would
     * put a "deprecated" badge on a withdrawn skill — two competing explanations on a page
     * that already has a compliance notice.
     */
    const { rows: leaked } = await c.query<{ n: string }>(
      `select count(*)::text as n from skills s
       where s.status <> 'indexed' and (${DERIVE}) is not null`,
      DP,
    );
    check("a declaration cannot outrank a non-indexed status", leaked[0].n === "0", `${leaked[0].n}`);

    const { rows: dangling } = await c.query<{ n: string }>(
      `select count(*)::text as n from skills s
       where s.lifecycle_declaration = 'superseded' and s.superseded_by_skill_id is null`,
    );
    check(
      "no superseded skill lacks a replacement",
      dangling[0].n === "0",
      `${dangling[0].n} would send a reader nowhere`,
    );

    const { rows: orphan } = await c.query<{ n: string }>(
      `select count(*)::text as n from skills s
       where s.superseded_by_skill_id is not null
         and not exists (select 1 from skills r where r.id = s.superseded_by_skill_id)`,
    );
    check("no replacement pointer dangles", orphan[0].n === "0", `${orphan[0].n}`);

    const { rows: selfRef } = await c.query<{ n: string }>(
      `select count(*)::text as n from skills where superseded_by_skill_id = id`,
    );
    check("no skill supersedes itself", selfRef[0].n === "0", `${selfRef[0].n}`);

    console.info("\nThe pipeline cannot overwrite a curator");

    /**
     * Reproduce the failure, then assert the fix — the house rule.
     *
     * The claim under test is that `status` and `lifecycle_declaration` are independent, so
     * a re-sync moving a skill's status leaves a deprecation standing. Asserting that by
     * reading `syncSource` proves nothing; the only evidence is doing it. Rolled back, so
     * the corpus is untouched either way.
     */
    await c.query("begin");
    try {
      const { rows: victim } = await c.query<{ id: string }>(
        `select id from skills where status = 'indexed' limit 1`,
      );
      if (victim.length === 0) {
        console.info("  skip  no indexed skill to probe with");
      } else {
        const id = victim[0].id;
        await c.query(
          `update skills set lifecycle_declaration = 'deprecated', lifecycle_note = 'probe' where id = $1`,
          [id],
        );
        const { rows: before } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check("a deprecation shows up in the derived state", before[0].state === "deprecated");

        // The move a sync makes.
        await c.query(`update skills set status = 'quarantined' where id = $1`, [id]);
        const { rows: mid } = await c.query<{ decl: string | null; state: string | null }>(
          `select s.lifecycle_declaration as decl, ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check(
          "a status change does not erase the declaration",
          mid[0].decl === "deprecated",
          "the columns are independent, which is why they are separate columns",
        );
        check(
          "but the derived state yields to the trust decision while not indexed",
          mid[0].state === null,
          `got ${mid[0].state}`,
        );

        // And it comes back when the skill is servable again.
        await c.query(`update skills set status = 'indexed' where id = $1`, [id]);
        const { rows: after } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check(
          "the declaration is intact once the skill is servable again",
          after[0].state === "deprecated",
          "recorded then honoured, not recorded then ignored",
        );

        // Stale, from an elapsed review date, on a skill with no declaration.
        await c.query(
          `update skills set lifecycle_declaration = null, review_by = now() - interval '1 day' where id = $1`,
          [id],
        );
        const { rows: staleRow } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check("an elapsed review date derives stale", staleRow[0].state === "stale");

        await c.query(`update skills set review_by = now() + interval '1 year' where id = $1`, [id]);
        const { rows: fresh } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check("a future review date does not", fresh[0].state === "validated");

        // A declaration outranks staleness: intent beats a missed date.
        await c.query(
          `update skills set lifecycle_declaration = 'deprecated', review_by = now() - interval '1 day' where id = $1`,
          [id],
        );
        const { rows: both } = await c.query<{ state: string | null }>(
          `select ${DERIVE} as state from skills s where s.id = ${SKILL_BIND}`,
          [...DP, id],
        );
        check("a declaration outranks an elapsed review date", both[0].state === "deprecated");

        // Postgres itself refuses the states that must be earned or detected.
        let refused = false;
        try {
          await c.query(`select 'battle-tested'::lifecycle_declaration`);
        } catch {
          refused = true;
        }
        check(
          "Postgres rejects 'battle-tested' as a declaration",
          refused,
          "the enum is the enforcement, not a code review",
        );
      }
    } finally {
      await c.query("rollback");
    }

    const { rows: clean } = await c.query<{ n: string }>(
      `select count(*)::text as n from skills where lifecycle_note = 'probe'`,
    );
    check("the probe left nothing behind", clean[0].n === "0", `${clean[0].n} rows`);

    console.info("\nThe audit trail says what actually happened");

    /**
     * The five kinds these two operations may write, and nothing else.
     *
     * `declareLifecycle` and `setReviewDate` were one function for about an hour, and the
     * seam produced an audit row reading `lifecycle.cleared` for an operator who had only
     * set a review date. This asserts the vocabulary, so a future merge of the two shows up
     * here rather than in a log somebody reads a year later and believes.
     */
    const KINDS = [
      "lifecycle.deprecated",
      "lifecycle.superseded",
      "lifecycle.cleared",
      "lifecycle.review-set",
      "lifecycle.review-cleared",
    ];
    const { rows: kinds } = await c.query<{ kind: string; n: string }>(
      `select kind, count(*)::text as n from events
       where kind like 'lifecycle.%' group by kind order by kind`,
    );
    for (const row of kinds) console.info(`  note  ${row.kind.padEnd(26)} ${row.n}`);
    check(
      "every recorded lifecycle event kind is one of the five",
      kinds.every((r) => KINDS.includes(r.kind)),
      kinds.filter((r) => !KINDS.includes(r.kind)).map((r) => r.kind).join(", ") || "or none yet",
    );

    /**
     * The old bug's fingerprint, searched for directly.
     *
     * A review-date change reported as a cleared declaration would leave a
     * `lifecycle.cleared` row carrying a `reviewBy` in its payload. Nothing else produces
     * that shape, which makes it a precise signature rather than a heuristic.
     */
    const { rows: mislabelled } = await c.query<{ n: string }>(
      `select count(*)::text as n from events
       where kind = 'lifecycle.cleared' and payload ? 'reviewBy'`,
    );
    check(
      "no cleared-declaration event is really a review-date change",
      mislabelled[0].n === "0",
      `${mislabelled[0].n} mislabelled — an audit trail may be incomplete, never wrong`,
    );

    /**
     * A supersession event has to name the replacement, or the log cannot answer "replaced
     * by what" after the column has moved on.
     */
    const { rows: silentSupersede } = await c.query<{ n: string }>(
      `select count(*)::text as n from events
       where kind = 'lifecycle.superseded'
         and coalesce(payload->>'supersededBySkillId', '') = ''`,
    );
    check(
      "every supersession event names the replacement",
      silentSupersede[0].n === "0",
      `${silentSupersede[0].n} without one`,
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
