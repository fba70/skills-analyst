import "dotenv/config";

import { MAINTAINER_AXES } from "../src/lib/maintainers";
import {
  endorsedSkills,
  grantMaintainer,
  listMaintainers,
  maintainerSummary,
  revokeMaintainer,
  scopeOf,
} from "../src/server/curation/maintainers";
import { DOMAINS, FUNCTIONS } from "../src/server/taxonomy/vocabulary";

/**
 * Maintainer groups and endorsement (Doc 6 RK.6, plan step E5). All free — no model call.
 *
 *   pnpm maintainers --status                        who maintains what, and what they have done
 *   pnpm maintainers --grant <email> <axis> <cat>    appoint, with an optional --note
 *   pnpm maintainers --revoke <email> <axis> <cat>   withdraw standing; the row is kept
 *   pnpm maintainers --scope <email>                 how many skills that person may act on
 *
 * A CLI rather than only a settings panel, for the same reason `lifecycle` and `submit` are:
 * these are curator operations on one named person, and typing an email into a terminal is how
 * the first appointment gets made on a deployment that has no maintainers yet.
 *
 * ## `--grant` needs an actor and takes one honestly
 *
 * Every appointment writes an `events` row, and `events.actor_id` is a real foreign key — the
 * string `"verify-script"` was refused by it once already. So the CLI requires `--by <email>`:
 * an appointment that cannot say who made it is exactly the audit gap R7.1 exists to close.
 */

const args = process.argv.slice(2);
const valueAfter = (flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

async function actorId(): Promise<string> {
  const email = valueAfter("--by");
  if (!email) {
    console.error("Say who is doing this: --by <your-email>");
    process.exit(1);
  }
  const { db } = await import("../src/server/db");
  const { user } = await import("../src/server/db/schema");
  const { sql } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1);
  if (!row) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
  return row.id;
}

function positional(flag: string): [string, string, string] {
  const index = args.indexOf(flag);
  const [email, axis, category] = args.slice(index + 1, index + 4);
  if (!email || !axis || !category) {
    console.error(`Usage: pnpm maintainers ${flag} <email> <axis> <category> --by <your-email>`);
    console.error(`  axis: ${MAINTAINER_AXES.join(" | ")}`);
    process.exit(1);
  }
  return [email, axis, category];
}

if (args.includes("--grant")) {
  const [email, axis, category] = positional("--grant");
  const outcome = await grantMaintainer({
    email,
    axis,
    category,
    note: valueAfter("--note") ?? null,
    actorId: await actorId(),
  });
  console.info(outcome.ok ? `  ${outcome.message}` : `  refused: ${outcome.message}`);
  process.exit(outcome.ok ? 0 : 1);
}

if (args.includes("--revoke")) {
  const [email, axis, category] = positional("--revoke");
  const { db } = await import("../src/server/db");
  const { user } = await import("../src/server/db/schema");
  const { sql } = await import("drizzle-orm");
  const [target] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1);
  if (!target) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
  const outcome = await revokeMaintainer({
    userId: target.id,
    axis,
    category,
    actorId: await actorId(),
  });
  console.info(outcome.ok ? `  ${outcome.message}` : `  refused: ${outcome.message}`);
  process.exit(outcome.ok ? 0 : 1);
}

if (args.includes("--scope")) {
  const email = valueAfter("--scope");
  const { db } = await import("../src/server/db");
  const { user } = await import("../src/server/db/schema");
  const { sql } = await import("drizzle-orm");
  const [target] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email ?? ""})`)
    .limit(1);
  if (!target) {
    console.error(`No account with the email ${email}.`);
    process.exit(1);
  }
  const scope = await scopeOf(target.id);
  console.info(`\n  ${target.name}`);
  if (scope.held.length === 0) {
    console.info("  maintains nothing.\n");
  } else {
    for (const held of scope.held) console.info(`    ${held.axis.padEnd(8)} ${held.category}`);
    console.info(`\n  ${scope.skills.toLocaleString()} servable skill(s) in scope.\n`);
  }
  process.exit(0);
}

/* Default: the status report. */
const [summary, roster, endorsed] = await Promise.all([
  maintainerSummary(),
  listMaintainers({ includeRevoked: true }),
  endorsedSkills(20),
]);

console.info("\nMaintainer groups (RK.6)\n");
console.info(
  `  ${summary.maintainers.people} person/people · ${summary.maintainers.categories} ` +
    `category/ies covered · ${summary.maintainers.revoked} withdrawn`,
);
console.info(
  `  ${summary.endorsements.live} live endorsement(s) across ${summary.endorsements.skills} ` +
    `skill(s) · ${summary.endorsements.withdrawn} withdrawn\n`,
);

if (roster.length === 0) {
  console.info("  Nobody maintains anything yet.");
  console.info("  pnpm maintainers --grant <email> function review --by <your-email>\n");
} else {
  for (const row of roster) {
    const state = row.revokedAt ? ` (withdrawn ${row.revokedAt.toISOString().slice(0, 10)})` : "";
    console.info(`  ${row.name.padEnd(24)} ${row.axis.padEnd(8)} ${row.categoryLabel}${state}`);
  }
  console.info("");
}

/*
 * The uncovered list, from the real vocabulary rather than a remembered one.
 *
 * Printed because it is the number an admin acts on: a roster of five names looks like progress
 * until you see it against thirty-nine categories. Same argument as `/archetypes` listing the
 * categories below the evidence gate instead of hiding them.
 */
const live = new Set(roster.filter((r) => !r.revokedAt).map((r) => `${r.axis}:${r.category}`));
const uncovered = [
  ...FUNCTIONS.filter((c) => !live.has(`function:${c.id}`)).map((c) => `function/${c.id}`),
  ...DOMAINS.filter((c) => !live.has(`domain:${c.id}`)).map((c) => `domain/${c.id}`),
];
console.info(
  `  ${uncovered.length} of ${FUNCTIONS.length + DOMAINS.length} categories have nobody:`,
);
console.info(`    ${uncovered.join(", ") || "none"}\n`);

if (endorsed.length > 0) {
  console.info("  Endorsed skills (most recent first)\n");
  for (const row of endorsed) {
    console.info(`    ${String(row.endorsements).padStart(2)}  ${row.slug}`);
  }
  console.info("");
}

process.exit(0);
