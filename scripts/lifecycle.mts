import "dotenv/config";

import { eq } from "drizzle-orm";

import { LIFECYCLE_META, LIFECYCLE_STATES } from "../src/lib/lifecycle";
import { db } from "../src/server/db";
// The concrete module, not the barrel: `schema/index.ts` re-exports with `export *`, and a
// native-ESM .mts script cannot see named exports through that chain. Every other script in
// here already imports the file directly — this one was the exception and it crashed on the
// first run.
import { skills } from "../src/server/db/schema/corpus";
import { declareLifecycle, lifecycleSummary, setReviewDate } from "../src/server/skills/lifecycle";

/**
 * Skill lifecycle: read the states, declare the two that a person may assert (Doc 6 RK.1).
 *
 *   pnpm lifecycle --status
 *   pnpm lifecycle --deprecate <slug> --note "superseded by the new pipeline"
 *   pnpm lifecycle --supersede <slug> --by <slug> --note "..."
 *   pnpm lifecycle --review-by <slug> 2027-01-31
 *   pnpm lifecycle --clear <slug>
 *
 * Free. No model, no network.
 *
 * ## Why a CLI and not a settings panel
 *
 * The same reason `submit`, `promote`, `rescan` and `registry` are CLIs: this is a curator
 * operation on one named skill, and there is no per-skill admin page to hang it on. Building
 * one is the *ownership workflow* half of RK.1, which the plan puts in E1 alongside the
 * freshness nudges it exists to serve — a panel that lets an admin set a review date but
 * cannot yet tell anyone it has passed is furniture.
 *
 * Every write goes through `declareLifecycle`, which validates the arguments, writes the
 * audit event in the same transaction, and is the only path. This file holds no SQL of its
 * own: it resolves a slug and prints a result.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith("--") ? value : undefined;
};

/**
 * The actor on an audit row, when the actor is a person at a terminal.
 *
 * `cli` rather than a fabricated user id: R7.1 wants to know who, and inventing an identity
 * to fill the column would make the log confidently wrong. The pipeline already tags its own
 * events this way.
 */
const ACTOR = "cli";

async function resolve(slug: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);
  return row ?? null;
}

async function status() {
  const { rows, governance } = await lifecycleSummary();
  const total = rows.reduce((sum, r) => sum + r.count, 0);

  console.info("\nSkill lifecycle");
  for (const state of LIFECYCLE_STATES) {
    const row = rows.find((r) => r.state === state);
    const count = row?.count ?? 0;
    const share = total > 0 ? (count / total) * 100 : 0;
    const meta = LIFECYCLE_META[state];
    console.info(
      `  ${meta.label.padEnd(15)} ${String(count).padStart(7)}  ${share.toFixed(1).padStart(5)}%` +
        `  ${meta.origin.padEnd(8)} ${"█".repeat(Math.round(share / 2.5))}`,
    );
  }
  const na = rows.find((r) => r.state === "not-applicable")?.count ?? 0;
  console.info(
    `  ${"(not indexed)".padEnd(15)} ${String(na).padStart(7)}` +
      `         no lifecycle — the trust surface says why`,
  );

  console.info("\nContent governance");
  console.info(`  with a review date   ${governance.withReviewDate}`);
  console.info(`  overdue              ${governance.overdue}`);
  console.info(`  with a named owner   ${governance.withOwner}`);

  /**
   * Said out loud, because a table of zeros invites the wrong conclusion.
   *
   * `battle-tested` reads zero and will keep reading zero until outcome telemetry exists;
   * that is the design, not a gap in the data. The same output with no explanation is how
   * `archetypes --blocks` came to print eleven rows of zeros and look like a finding.
   */
  console.info(
    "\n  Battle-tested is 0 by construction: it is earned from post-publication evidence",
  );
  console.info("  (R6.3, plan step B1), and none is collected yet. There is no column for it.\n");
}

if (args.includes("--status") || args.length === 0) {
  await status();
  process.exit(0);
}

const deprecate = flag("deprecate");
const supersede = flag("supersede");
const clear = flag("clear");
const reviewByTarget = flag("review-by");

if (deprecate || supersede || clear) {
  const slug = (deprecate ?? supersede ?? clear)!;
  const target = await resolve(slug);
  if (!target) {
    console.error(`\n  No skill with slug ${slug}\n`);
    process.exit(1);
  }

  let supersededBySkillId: string | null = null;
  if (supersede) {
    const by = flag("by");
    if (!by) {
      console.error("\n  --supersede needs --by <slug> naming the replacement\n");
      process.exit(1);
    }
    const replacement = await resolve(by);
    if (!replacement) {
      console.error(`\n  No skill with slug ${by}\n`);
      process.exit(1);
    }
    supersededBySkillId = replacement.id;
  }

  const result = await declareLifecycle({
    skillId: target.id,
    declaration: clear ? null : supersede ? "superseded" : "deprecated",
    supersededBySkillId,
    note: flag("note") ?? null,
    actorId: ACTOR,
  });

  if (!result.ok) {
    console.error(`\n  Refused: ${result.error}\n`);
    process.exit(1);
  }
  console.info(`\n  ${target.name} (${slug}) is now: ${result.state ?? "not applicable"}\n`);
  process.exit(0);
}

if (reviewByTarget) {
  /**
   * `--review-by <slug> <date|clear>`: the slug is the flag's value, the date follows it.
   *
   * `clear` is handled *before* parsing, which is the bug this shape shipped with: the guard
   * ran `new Date("clear")`, got an invalid date, and rejected the one option the usage
   * string above advertised. A documented path that was never once executed.
   */
  const raw = args[args.indexOf("--review-by") + 2];
  const clearing = raw === "clear";
  const date = !clearing && raw && !raw.startsWith("--") ? new Date(raw) : null;
  if (!clearing && (!date || Number.isNaN(date.getTime()))) {
    console.error("\n  --review-by <slug> <YYYY-MM-DD>   (or --review-by <slug> clear)\n");
    process.exit(1);
  }
  const target = await resolve(reviewByTarget);
  if (!target) {
    console.error(`\n  No skill with slug ${reviewByTarget}\n`);
    process.exit(1);
  }

  /**
   * A separate operation from a declaration, so the audit row says what actually happened.
   * Folding the two together once wrote `lifecycle.cleared` for an operator who had only
   * set a date, and wiped the deprecation note on the way past.
   */
  const result = await setReviewDate({
    skillId: target.id,
    reviewBy: clearing ? null : date,
    actorId: ACTOR,
  });
  if (!result.ok) {
    console.error(`\n  Refused: ${result.error}\n`);
    process.exit(1);
  }
  console.info(
    `\n  ${target.name} (${reviewByTarget}) ` +
      (clearing ? "review date cleared" : `review due ${date!.toISOString().slice(0, 10)}`) +
      ` — now: ${result.state ?? "not applicable"}\n`,
  );
  process.exit(0);
}

await status();
process.exit(0);
