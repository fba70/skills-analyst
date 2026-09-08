import "dotenv/config";

import { Client } from "pg";

import { FEATURES, FREE_FOREVER } from "../src/lib/plans";
import {
  ENDORSE_REFUSAL_MESSAGE,
  ENDORSE_REFUSALS,
  endorsementLine,
  isMaintainerAxis,
  MAINTAINER_AXES,
  MAX_ENDORSEMENT_NOTE,
} from "../src/lib/maintainers";
import { DOMAINS, FUNCTIONS } from "../src/server/taxonomy/vocabulary";

/**
 * Maintainer groups, earned curation rights and endorsement (Doc 6 RK.6, plan step E5).
 *
 *   pnpm verify:maintainers
 *
 * Free — no model call. Every row it writes goes through the real functions and is removed in a
 * `finally`, because this suite grants somebody live authority over a category and leaving that
 * behind would be worse than leaving test data behind.
 *
 * ## The properties this file exists to protect
 *
 * 1. **An endorsement counts only while the standing behind it does.** Revoking a maintainer
 *    must make their endorsements disappear from every read on the next query, with no sweep and
 *    no stored copy of who maintains what. This is the single most likely thing to be broken by
 *    a well-meaning "let's denormalise the join" change, and it is checked by *reproducing the
 *    before state first* — endorse, see it, revoke, see it gone, re-grant, see it return.
 * 2. **Nobody without standing can endorse.** Checked by observing the refusal before the grant,
 *    so the later success is proof the grant did something rather than proof the check is absent.
 * 3. **A maintainer's queue is bounded by their categories.** An empty scope must return nothing,
 *    not everything — the difference between a delegated queue and a second admin.
 * 4. **Endorsements can never be paywalled.** `endorsements` is a `FREE_FOREVER` key, and the
 *    absence of an endorsement is the half a reader most needs.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary");

/*
 * The axis list is spelled twice — once in the leaf module client components load, once in the
 * taxonomy under `src/server/`. Two copies is a standing hazard in this codebase, so the copy is
 * checked rather than trusted. Both directions, because a subset passes a one-way test.
 */
const taxonomyAxes = ["function", "domain"] as const;
check(
  "the leaf module's axes are exactly the taxonomy's axes",
  MAINTAINER_AXES.length === taxonomyAxes.length &&
    taxonomyAxes.every((a) => (MAINTAINER_AXES as readonly string[]).includes(a)) &&
    MAINTAINER_AXES.every((a) => (taxonomyAxes as readonly string[]).includes(a)),
  MAINTAINER_AXES.join(", "),
);
check("an unknown axis is refused", !isMaintainerAxis("category"));
check(
  "every refusal has its own sentence",
  new Set(ENDORSE_REFUSALS.map((r) => ENDORSE_REFUSAL_MESSAGE[r])).size ===
    ENDORSE_REFUSALS.length,
  `${ENDORSE_REFUSALS.length} refusals`,
);
check(
  "the note is a sentence, not a review",
  MAX_ENDORSEMENT_NOTE > 0 && MAX_ENDORSEMENT_NOTE <= 500,
  `${MAX_ENDORSEMENT_NOTE} characters`,
);
check(
  "the count reads as a sentence at zero, one and many",
  endorsementLine(0) === "No endorsements" &&
    endorsementLine(1).includes("1 maintainer endorses") &&
    endorsementLine(3).includes("3 maintainers endorse"),
);

console.info("\nEndorsement cannot be sold");

check(
  "`endorsements` is free for ever",
  (FREE_FOREVER as readonly string[]).includes("endorsements"),
);
check(
  "and is not also a gateable feature",
  !(FEATURES as readonly string[]).includes("endorsements"),
  "a key in both vocabularies resolves whichever way two ifs happen to be ordered",
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
    `select to_regclass('public.category_maintainers') is not null
        and to_regclass('public.skill_endorsements') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  tables absent — apply the migration: pnpm db:migrate");
  } else {
    check(
      "both tables carry a row-level security policy",
      Number(
        (
          await c.query<{ n: string }>(
            `select count(*)::text as n from pg_policies
              where tablename in ('category_maintainers', 'skill_endorsements')`,
          )
        ).rows[0].n,
      ) >= 2,
    );
    check(
      "an endorsement records which version was read",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from information_schema.columns
            where table_name = 'skill_endorsements' and column_name = 'skill_version_id'`,
        )
      ).rows[0].n === "1",
      "without it a re-sync would silently make a maintainer vouch for text they never saw",
    );
    check(
      "standing is withdrawn rather than deleted",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from information_schema.columns
            where table_name = 'category_maintainers' and column_name = 'revoked_at'`,
        )
      ).rows[0].n === "1",
    );

    /*
     * A skill with a servable category, and somebody to appoint.
     *
     * Both are real rows: this suite grants real authority and endorses a real skill through the
     * real functions, because a hand-written insert would prove the tables work and nothing about
     * whether the rules do. Everything is removed in the `finally`.
     */
    const { rows: candidates } = await c.query<{
      skill_id: string;
      slug: string;
      axis: string;
      value: string;
    }>(
      `select s.id as skill_id, s.slug, sc.axis::text as axis, sc.value
         from skills s
         join skill_categories sc on sc.skill_id = s.id
        where s.status = 'indexed'
          and s.org_id is null
          and s.current_version_id is not null
          and (sc.confidence >= 60 or sc.reviewed_at is not null)
        limit 1`,
    );
    const { rows: people } = await c.query<{ id: string; email: string }>(
      `select id, email from "user" order by created_at limit 1`,
    );

    if (candidates.length === 0 || people.length === 0) {
      console.info(
        "  skip  needs one indexed public skill with a servable category and one account — " +
          "run `pnpm pipeline` and `pnpm taxonomy --sample 20`",
      );
    } else {
      const skill = candidates[0];
      const person = people[0];
      const {
        canCurate,
        endorse,
        endorseAffordance,
        endorsementsFor,
        grantMaintainer,
        revokeMaintainer,
        withdrawEndorsement,
      } = await import("../src/server/curation/maintainers");
      const { flagQueue } = await import("../src/server/curation/flags");

      try {
        /* 1. Reproduce the before state, so the after state proves something. */
        const before = await endorsementsFor(skill.skill_id);
        const refusedFirst = await endorse({ slug: skill.slug, userId: person.id });
        check(
          "somebody with no standing cannot endorse",
          !refusedFirst.ok && refusedFirst.refusal === "not-a-maintainer",
          refusedFirst.ok ? "it succeeded" : refusedFirst.refusal,
        );
        check(
          "and cannot decide a report on it either",
          !(await canCurate(person.id, skill.skill_id)),
        );
        const eligibleBefore = before.eligible;

        /* 2. Appoint, and watch both rights arrive together. */
        const granted = await grantMaintainer({
          email: person.email,
          axis: skill.axis,
          category: skill.value,
          note: "verify:maintainers probe",
          actorId: person.id,
        });
        check("an appointment is accepted", granted.ok, granted.message);
        check(
          "the curation right arrives with the standing",
          await canCurate(person.id, skill.skill_id),
        );
        const affordance = await endorseAffordance(person.id, skill.skill_id);
        check(
          "and so does the endorse control",
          affordance.eligible && !affordance.already,
        );

        const invented = await grantMaintainer({
          email: person.email,
          axis: skill.axis,
          category: "not-a-real-category",
          actorId: person.id,
        });
        check(
          "a category that does not exist is refused, not stored",
          !invented.ok,
          "an appointment nothing can match would look like standing and authorise nothing",
        );

        /* 3. Endorse, and read it back. */
        const endorsed = await endorse({
          slug: skill.slug,
          userId: person.id,
          note: "verify:maintainers probe",
        });
        check("a maintainer may endorse a skill in their category", endorsed.ok);

        const withOne = await endorsementsFor(skill.skill_id);
        check(
          "the endorsement is visible, under the category it was made in",
          withOne.endorsements.length === before.endorsements.length + 1 &&
            withOne.endorsements.some((e) => e.category === skill.value),
        );
        check(
          "it is not marked stale, because it names the current version",
          withOne.endorsements.every((e) => e.userId !== person.id || !e.stale),
        );
        check(
          "the eligible count moved with the appointment",
          withOne.eligible === eligibleBefore + 1,
          `${eligibleBefore} → ${withOne.eligible}`,
        );

        /* Endorsing twice is one person saying one thing. */
        await endorse({ slug: skill.slug, userId: person.id, note: "again" });
        const { rows: rowCount } = await c.query<{ n: string }>(
          `select count(*)::text as n from skill_endorsements where skill_id = $1 and user_id = $2`,
          [skill.skill_id, person.id],
        );
        check(
          "endorsing twice updates one row rather than counting twice",
          rowCount[0].n === "1",
          `${rowCount[0].n} row(s)`,
        );

        /* 4. The headline: revoking the standing removes the endorsement from every read. */
        const revoked = await revokeMaintainer({
          userId: person.id,
          axis: skill.axis,
          category: skill.value,
          actorId: person.id,
        });
        check("standing can be withdrawn", revoked.ok);

        const afterRevoke = await endorsementsFor(skill.skill_id);
        check(
          "an endorsement stops counting the moment the standing does",
          !afterRevoke.endorsements.some((e) => e.userId === person.id),
          "resolved by a live join, so there is no stored copy and nothing to sweep",
        );
        check(
          "and the eligible count falls back",
          afterRevoke.eligible === eligibleBefore,
          `${afterRevoke.eligible}`,
        );
        check(
          "the curation right goes with it",
          !(await canCurate(person.id, skill.skill_id)),
        );

        const { rows: kept } = await c.query<{ n: string }>(
          `select count(*)::text as n from category_maintainers where user_id = $1 and category = $2`,
          [person.id, skill.value],
        );
        check(
          "the withdrawn standing is kept, not deleted",
          kept[0].n === "1",
          "the decisions made under it are in the audit log and must stay readable",
        );

        /* 5. Re-granting restores the endorsement rather than losing it. */
        await grantMaintainer({
          email: person.email,
          axis: skill.axis,
          category: skill.value,
          actorId: person.id,
        });
        const restored = await endorsementsFor(skill.skill_id);
        check(
          "re-appointing brings the endorsement back",
          restored.endorsements.some((e) => e.userId === person.id),
          "the row was never deleted; it simply stopped counting",
        );
        const { rows: oneRow } = await c.query<{ n: string }>(
          `select count(*)::text as n from category_maintainers where user_id = $1 and category = $2`,
          [person.id, skill.value],
        );
        check(
          "re-appointing does not write a second standing row",
          oneRow[0].n === "1",
          "two rows for one pair would leave every read choosing between them",
        );

        /* 6. Withdrawing the endorsement is the endorser's own call, and it hides the row. */
        const pulled = await withdrawEndorsement({ slug: skill.slug, userId: person.id });
        check("an endorser may take their name back", pulled.ok);
        const afterWithdraw = await endorsementsFor(skill.skill_id);
        check(
          "a withdrawn endorsement is invisible everywhere at once",
          !afterWithdraw.endorsements.some((e) => e.userId === person.id),
        );
        const { rows: stillThere } = await c.query<{ n: string }>(
          `select count(*)::text as n from skill_endorsements
            where skill_id = $1 and user_id = $2 and withdrawn_at is not null`,
          [skill.skill_id, person.id],
        );
        check("the row and its audit trail survive the withdrawal", stillThere[0].n === "1");

        /* 7. The queue is bounded, and an empty scope is not a wildcard. */
        const emptyScope = await flagQueue("received", []);
        check(
          "a maintainer of nothing sees an empty queue, not the whole one",
          emptyScope.length === 0,
          "the inverted version of this is a second admin nobody appointed",
        );
        const adminQueue = await flagQueue("received", null);
        const wrongScope = await flagQueue("received", [
          { axis: "function", category: "not-a-real-category" },
        ]);
        check(
          "a scope that matches no category returns nothing",
          wrongScope.length === 0,
          `the unscoped queue holds ${adminQueue.length}`,
        );
      } finally {
        /*
         * Cleanup in a `finally`, and through the owner connection.
         *
         * `verify:schedule` left the live classifier pointed at the wrong model once because its
         * restore ran after an assertion that threw. This suite hands somebody authority over a
         * category, which is worse to leave behind than a setting.
         */
        await c.query(`delete from skill_endorsements where skill_id = $1 and user_id = $2`, [
          skill.skill_id,
          person.id,
        ]);
        await c.query(
          `delete from category_maintainers where user_id = $1 and category = $2 and axis = $3`,
          [person.id, skill.value, skill.axis],
        );
        await c.query(
          `delete from events
            where kind in ('maintainer.granted', 'maintainer.revoked', 'skill.endorsed',
                           'skill.endorsement-withdrawn')
              and actor_id = $1
              and at > now() - interval '10 minutes'`,
          [person.id],
        );
        const { rows: leftovers } = await c.query<{ n: string }>(
          `select (select count(*) from category_maintainers where user_id = $1 and category = $2)
                + (select count(*) from skill_endorsements where skill_id = $3 and user_id = $1)
                as n`,
          [person.id, skill.value, skill.skill_id],
        );
        check("the probe left nothing behind", leftovers[0].n === "0", `${leftovers[0].n} rows`);
      }
    }

    const { rows: coverage } = await c.query<{ live: string; people: string }>(
      `select count(*) filter (where revoked_at is null)::text as live,
              count(distinct user_id) filter (where revoked_at is null)::text as people
         from category_maintainers`,
    );
    console.info(
      `  note  ${coverage[0].people} maintainer(s) holding ${coverage[0].live} of ` +
        `${FUNCTIONS.length + DOMAINS.length} categories`,
    );
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
