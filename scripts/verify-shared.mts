import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { PLAN_FEATURES } from "../src/lib/plans";
import { REVISION_REASONS } from "../src/lib/draft-blocks";
import {
  MAX_SHARED_TEXT,
  SHARED_BLOCK_REFUSAL_MESSAGE,
  SHARED_BLOCK_REFUSALS,
  TRANSCLUSION_META,
  TRANSCLUSION_STATES,
  transclusionState,
} from "../src/lib/shared-blocks";

/**
 * A shared convention is synced, never substituted (Doc 6 RK.4, plan step E6).
 *
 *   pnpm verify:shared
 *
 * Free. The pure half needs no database; the stored half writes a real convention and a real
 * draft through the real functions and removes both in a `finally`.
 *
 * ## The property this file exists to protect
 *
 * **Editing a convention must change no draft.** The obvious build resolves a transclusion live,
 * and then a colleague editing "our PII guardrail" at 11am rewrites forty documents in the middle
 * of sentences their authors wrote, with nothing in any revision history saying so. This suite
 * edits a convention a draft uses and asserts the draft's own text is **byte-identical**
 * afterwards — and that the update is nonetheless offered, because a mechanism that changes
 * nothing and *says* nothing would be no feature at all.
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
  "three transclusion states, each with its own sentence",
  TRANSCLUSION_STATES.length === 3 &&
    new Set(TRANSCLUSION_STATES.map((s) => TRANSCLUSION_META[s].blurb)).size === 3,
  TRANSCLUSION_STATES.join(", "),
);
check(
  "a block at the convention's version is in step",
  transclusionState({ sharedVersion: 3, blockVersion: 3, retired: false }) === "current",
);
check(
  "a block behind it has an update waiting",
  transclusionState({ sharedVersion: 4, blockVersion: 3, retired: false }) === "behind",
);
check(
  "a retired convention says so whatever the versions",
  transclusionState({ sharedVersion: 9, blockVersion: 1, retired: true }) === "retired",
  "the author's copy is untouched and simply stops tracking",
);
check(
  "the behind message says nothing was rewritten",
  TRANSCLUSION_META.behind.blurb.includes("Nothing was rewritten"),
  "the one sentence that stops somebody assuming their draft changed under them",
);
check(
  "every refusal has its own sentence",
  new Set(SHARED_BLOCK_REFUSALS.map((r) => SHARED_BLOCK_REFUSAL_MESSAGE[r])).size ===
    SHARED_BLOCK_REFUSALS.length,
  `${SHARED_BLOCK_REFUSALS.length} refusals`,
);
check(
  "a convention is capped at a block's length, not a section's",
  MAX_SHARED_TEXT > 0 && MAX_SHARED_TEXT <= 4_000,
  `${MAX_SHARED_TEXT} characters`,
);

console.info("\nGated, and written through the one writer");

check(
  "shared blocks are Team, never free and never Pro",
  !PLAN_FEATURES.free.includes("shared-blocks") &&
    !PLAN_FEATURES.pro.includes("shared-blocks") &&
    PLAN_FEATURES.team.includes("shared-blocks"),
);
check(
  "an added or updated convention is distinguishable in the revision history",
  (REVISION_REASONS as readonly string[]).includes("shared"),
  "an author asking where a paragraph came from should not be told `edited`",
);

const sharedSource = readFileSync(join(process.cwd(), "src/server/builder/shared.ts"), "utf8");
check(
  "the module never writes draft_blocks directly",
  !/insert\(draftBlocks\)|update\(draftBlocks\)/.test(sharedSource),
  "a transclusion is an ordinary block with a provenance, written by setDraftBlocks like any other",
);
check(
  "and it never writes skill_drafts.body",
  !/skillDrafts[\s\S]{0,400}body:/.test(sharedSource),
);
check(
  "editing a convention touches no draft table at all",
  (() => {
    const fn = sharedSource.slice(
      sharedSource.indexOf("export async function updateSharedBlock"),
      sharedSource.indexOf("export async function retireSharedBlock"),
    );
    /* It may *count* dependents; it may not write to them. */
    return !/update\(draftBlocks\)|setDraftBlocks\(/.test(fn) && fn.includes("draftBlocks");
  })(),
  "it counts dependents and changes none of them",
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
    `select to_regclass('public.shared_blocks') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — the migration is not applied yet");
  } else {
    const { rows: policy } = await c.query<{ qual: string }>(
      `select qual from pg_policies where tablename = 'shared_blocks'`,
    );
    check(
      "a convention is org-scoped with no public escape hatch",
      policy.length === 1 && !policy[0].qual.includes("is null"),
      "there is no such thing as a public convention (RC.5)",
    );
    check(
      "losing a convention nulls the pointer rather than deleting the author's paragraph",
      (
        await c.query<{ delete_rule: string }>(
          `select rc.delete_rule from information_schema.referential_constraints rc
             join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
            where tc.table_name = 'draft_blocks' and tc.constraint_name like '%shared_block%'`,
        )
      ).rows[0]?.delete_rule === "SET NULL",
    );
    check(
      "two conventions differing only in case are one convention",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes
            where tablename = 'shared_blocks' and indexdef ilike '%lower(name)%'`,
        )
      ).rows[0].n === "1",
      "the repository-identity fold, one layer up",
    );

    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    /*
     * A real user, because `created_by` is a real foreign key.
     *
     * `verify:models` already paid for this one: its actor was the string "verify-script" and the
     * `updated_by` key correctly refused it. A change has to be attributable to somebody who
     * exists, and a probe is not exempt.
     */
    const { rows: who } = await c.query<{ id: string }>(`select id from "user" order by created_at limit 1`);
    if (org.length === 0 || who.length === 0) {
      console.info("  skip  needs one organisation and one account to write a probe against");
    } else {
      const orgId = org[0].id;
      const userId = who[0].id;
      const { createSharedBlock, updateSharedBlock, transcludeSharedBlock, draftTransclusions, syncDraftTransclusions } =
        await import("../src/server/builder/shared");
      const { getDraftBlocks } = await import("../src/server/builder/blocks");
      const { skillDrafts } = await import("../src/server/db/schema");
      const { withExplicitOrgScope } = await import("../src/server/dal/scope");

      let draftId: string | null = null;
      let sharedId: string | null = null;
      try {
        draftId = await withExplicitOrgScope(orgId, async (tx) => {
          const [row] = await tx
            .insert(skillDrafts)
            .values({
              orgId,
              name: "verify:shared probe",
              slug: `verify-shared-probe-${Date.now()}`,
              purpose: "probe",
              archetypeCategory: "review",
              status: "ready",
            })
            .returning({ id: skillDrafts.id });
          return row.id;
        });

        const created = await createSharedBlock({
          orgId,
          userId,
          name: `probe-convention-${Date.now()}`,
          type: "guardrail",
          text: "Never deploy on a Friday.",
        });
        check("a convention is created", created.ok);
        if (!created.ok) throw new Error("cannot continue");
        sharedId = created.data.id;

        const added = await transcludeSharedBlock({
          orgId,
          userId,
          draftId,
          sharedBlockId: sharedId,
        });
        check("and pulled into a draft", added.ok);

        const before = await getDraftBlocks(draftId, orgId);
        const beforeText = before.map((block) => block.text).join("\n");
        check(
          "the block carries its own copy and the version it came from",
          before.some((block) => block.sharedBlockId === sharedId && block.sharedBlockVersion === 1),
        );

        /* The property the whole design rests on. */
        const edited = await updateSharedBlock({
          orgId,
          userId,
          id: sharedId,
          text: "Never deploy on a Friday, or the day before a holiday.",
        });
        check("the convention is edited and its version bumps", edited.ok && edited.data.version === 2);
        check(
          "and it reports how many drafts now depend on the change",
          edited.ok && edited.data.dependents === 1,
          "the number an editor should see before changing something forty drafts use",
        );

        const after = await getDraftBlocks(draftId, orgId);
        check(
          "the draft is byte-identical — editing a convention rewrote nothing",
          after.map((block) => block.text).join("\n") === beforeText,
          "live substitution would have changed somebody's document with no history of it",
        );

        const pending = await draftTransclusions(draftId, orgId);
        check(
          "but the update is offered",
          pending.some((row) => row.state === "behind"),
          "a mechanism that changes nothing and says nothing would be no feature at all",
        );

        const synced = await syncDraftTransclusions({ orgId, userId, draftId });
        check("taking the update applies it", synced.updated === 1);

        const final = await getDraftBlocks(draftId, orgId);
        check(
          "and the draft now carries the new text at the new version",
          final.some(
            (block) => block.text.includes("holiday") && block.sharedBlockVersion === 2,
          ),
        );

        const { rows: revision } = await c.query<{ reason: string }>(
          `select reason from draft_revisions where draft_id = $1 order by revision desc limit 1`,
          [draftId],
        );
        check(
          "the sync is in the revision history under its own reason",
          revision[0]?.reason === "shared",
          revision[0]?.reason ?? "none",
        );

        const noop = await updateSharedBlock({
          orgId,
          userId,
          id: sharedId,
          text: "Never deploy on a Friday, or the day before a holiday.",
        });
        check(
          "saving a convention unchanged does not put dependents behind",
          noop.ok && noop.data.version === 2,
          "otherwise forty people are asked to review a change nobody made",
        );
      } finally {
        /*
         * Cleanup in a `finally`, through the owner connection. `verify:schedule` left the live
         * classifier pointed at the wrong model once because its restore ran after a throw.
         */
        if (draftId) await c.query(`delete from skill_drafts where id = $1`, [draftId]);
        if (sharedId) await c.query(`delete from shared_blocks where id = $1`, [sharedId]);
        const { rows: left } = await c.query<{ n: string }>(
          `select (select count(*) from shared_blocks where name like 'probe-convention-%')
                + (select count(*) from skill_drafts where name = 'verify:shared probe') as n`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
