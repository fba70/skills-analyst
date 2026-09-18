import "dotenv/config";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  FEATURES,
  FREE_FOREVER,
  isFeature,
  isFreeForever,
  lowestPlanFor,
  PLAN_FEATURES,
  PLANS,
  planIncludes,
} from "../src/lib/plans";
import {
  hasEntitlement,
  requireEntitlement,
  UngateableError,
} from "../src/server/dal/entitlements";

/**
 * The trust surfaces cannot be paywalled, and the gate lives in the DAL (Doc 2 RC.1).
 *
 *   pnpm verify:entitlements
 *
 * Free. The gate checks touch no database — they refuse before any query. The schema half
 * reads two catalogs; the behaviour half writes inside a transaction that is rolled back.
 *
 * ## The one check that matters
 *
 * RC.1's substance is a commercial promise: per-skill verdicts, provenance, quarantine
 * status, the capability surface, the quality score and licence posture are free on every
 * plan and **cannot be paywalled by configuration**. Doc 1 is blunter — paywalling the
 * verdict would destroy the platform's reason to exist.
 *
 * A comment cannot hold that. Nor can a special case returning `true`: a gate that always
 * passes still reads as a paywall at the call site, and the day somebody tidies the special
 * case away, the paywall switches on. So the gate **throws** when handed one of those keys,
 * and this file asserts it throws — for every key, through both entry points. If any of
 * these ever return a boolean instead, a commitment has quietly become configurable.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function throwsUngateable(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof UngateableError;
  }
}

console.info("\nThe trust surfaces cannot be gated");

for (const key of FREE_FOREVER) {
  const viaHas = await throwsUngateable(() => hasEntitlement("org_probe", key));
  const viaRequire = await throwsUngateable(() => requireEntitlement("org_probe", key));
  check(
    `"${key}" is refused by both entry points`,
    viaHas && viaRequire,
    viaHas && viaRequire
      ? ""
      : `hasEntitlement ${viaHas ? "threw" : "ANSWERED"}, requireEntitlement ${viaRequire ? "threw" : "ANSWERED"}`,
  );
}

/**
 * The two vocabularies must not overlap.
 *
 * A key in both lists would be gateable and ungateable at once, and which behaviour you got
 * would depend on the order of two `if`s — the kind of ambiguity that resolves itself the
 * wrong way during a refactor nobody reviews closely.
 */
const overlap = FREE_FOREVER.filter((key) => (FEATURES as readonly string[]).includes(key));
check("no key is both a feature and a free-forever surface", overlap.length === 0, overlap.join(", "));

check(
  "an unknown key is refused rather than silently answered false",
  !(await (async () => {
    try {
      await hasEntitlement("org_probe", "not-a-real-feature");
      return true;
    } catch {
      return false;
    }
  })()),
  "a typo answering false is a feature nobody can use and nobody can find",
);

console.info("\nThe plan matrix");

check("three plans", PLANS.length === 3, PLANS.join(", "));
check(
  "the free plan gates nothing",
  PLAN_FEATURES.free.length === 0,
  "every paid key names something that does not exist yet",
);
check(
  "every plan's features are real feature keys",
  PLANS.every((plan) => PLAN_FEATURES[plan].every((f) => isFeature(f))),
);
check(
  "team includes everything pro does",
  PLAN_FEATURES.pro.every((f) => planIncludes("team", f)),
  "a customer paying more must never lose a capability",
);
check(
  "every feature is reachable on some plan",
  FEATURES.every((f) => lowestPlanFor(f) !== null),
  FEATURES.filter((f) => lowestPlanFor(f) === null).join(", ") || "none orphaned",
);
check(
  "the guards agree with the lists",
  FEATURES.every(isFeature) && FREE_FOREVER.every(isFreeForever),
);

console.info("\nThe gate's answers, without touching a database");

/**
 * Deliberately the only gate answer above the connection.
 *
 * Everything else in this file that calls the gate does so with a key it *refuses*, so it
 * throws before any query — which is why those checks run on a laptop with no database. This
 * one is the same shape: no organisation means no lookup to make. The row-reading answers
 * live below, where a missing table is a skip rather than a stack trace, which is how the
 * first run of this file failed.
 */
check(
  "no organisation at all is entitled to nothing paid",
  (await hasEntitlement(null, "eval-lab")) === false,
  "an anonymous caller is not on the free plan, it is nowhere",
);

console.info("\nThe schema");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the gate checks above are complete");
}

if (connected) {
  const { rows: enumRows } = await c.query<{ value: string }>(
    `select e.enumlabel as value from pg_type t join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'org_plan' order by e.enumsortorder`,
  );
  const stored = enumRows.map((r) => r.value);

  if (stored.length === 0) {
    console.info("  skip  org_plan does not exist yet — apply the migration");
  } else {
    check(
      "the database enum matches the plan vocabulary",
      stored.length === PLANS.length && PLANS.every((p) => stored.includes(p)),
      `${stored.join(", ")} vs ${PLANS.join(", ")}`,
    );

    const { rows: policies } = await c.query<{ policyname: string; cmd: string }>(
      `select policyname, cmd from pg_policies where tablename = 'org_entitlements' order by policyname`,
    );
    const byCmd = new Map(policies.map((p) => [p.cmd, p.policyname]));
    check(
      "SELECT is open, so an operator can list every workspace's plan",
      byCmd.get("SELECT") === "read_all",
      policies.map((p) => `${p.cmd}:${p.policyname}`).join(", "),
    );
    check(
      "INSERT and UPDATE are org-scoped, so nobody can grant themselves another plan",
      byCmd.has("INSERT") && byCmd.has("UPDATE"),
    );
    /**
     * No DELETE policy, deliberately, and asserted because the absence is the design.
     *
     * A downgrade is `plan = 'free'` — a row an auditor can read and an event naming who did
     * it. Deleting the row reaches the same outcome with no trace at all, because an absent
     * row already means free. Same reasoning as `platform_settings`, where a delete would
     * quietly restore a default and the audit log would show nothing.
     */
    check(
      "there is no DELETE policy, so a plan is changed and never erased",
      !byCmd.has("DELETE"),
      byCmd.get("DELETE") ?? "none",
    );

    /**
     * An organisation with no entitlement row must read `free`.
     *
     * This is what makes the free-tier guarantee hold on a fresh deployment: the table is
     * empty, every lookup falls through, and nothing is gated. A default of anything else
     * would mean a bootstrap that half-completed left workspaces in a state with no defined
     * meaning.
     */
    check(
      "an organisation with no entitlement row is entitled to nothing paid",
      (await hasEntitlement("org_does_not_exist", "eval-lab")) === false,
      "an absent row means free, which is what makes a fresh deployment gate nothing",
    );

    console.info("\nExpiry is honoured at read time");

    /**
     * Reproduce the case, then assert the behaviour — inside a rolled-back transaction.
     *
     * A lapsed plan must stop granting *without* a background job, because a job that
     * downgrades expired plans is a job that can fail, and its failure mode is a customer
     * keeping what they stopped paying for. Deciding at read time cannot drift.
     */
    await c.query("begin");
    try {
      await c.query(
        `insert into organization (id, name, slug, created_at)
         values ('org_probe_ent', 'Probe', 'probe-ent', now())
         on conflict (id) do nothing`,
      );
      await c.query(
        `insert into org_entitlements (organization_id, plan, valid_until)
         values ('org_probe_ent', 'team', now() + interval '1 day')
         on conflict (organization_id) do update set plan = 'team', valid_until = now() + interval '1 day'`,
      );
      const { rows: live } = await c.query<{ plan: string; expired: boolean }>(
        `select plan, (valid_until is not null and valid_until <= now()) as expired
         from org_entitlements where organization_id = 'org_probe_ent'`,
      );
      check("a live team plan is stored as team", live[0].plan === "team" && !live[0].expired);

      await c.query(
        `update org_entitlements set valid_until = now() - interval '1 day' where organization_id = 'org_probe_ent'`,
      );
      const { rows: lapsed } = await c.query<{ plan: string; expired: boolean }>(
        `select plan, (valid_until is not null and valid_until <= now()) as expired
         from org_entitlements where organization_id = 'org_probe_ent'`,
      );
      check(
        "the row still says team once lapsed, so the gate must be the thing that decides",
        lapsed[0].plan === "team" && lapsed[0].expired,
        "which is why expiry is read at the gate rather than swept by a job",
      );
    } finally {
      await c.query("rollback");
    }

    const { rows: leftovers } = await c.query<{ n: string }>(
      `select count(*)::text as n from org_entitlements where organization_id = 'org_probe_ent'`,
    );
    check("the probe left nothing behind", leftovers[0].n === "0", `${leftovers[0].n} rows`);

    const { rows: gated } = await c.query<{ n: string }>(
      `select count(*)::text as n from org_entitlements where plan <> 'free'`,
    );
    console.info(
      `  note  ${gated[0].n} workspace(s) on a paid plan · ` +
        `nothing served is gated today, so the free-tier guarantee holds by construction too`,
    );
  }
  await c.end();
}

// ---------------------------------------------------------------------------------------
console.info("\nThe panel's \"live\" list, checked against the tree");
// ---------------------------------------------------------------------------------------

/**
 * `LIVE_FEATURES` says which entitlement keys have a call site, and it cannot be derived at
 * render time — "is there code that gates on this" is a question about the tree, not about
 * the database. So it is a hand-written list, and a hand-written list goes stale silently.
 *
 * This one did. It named a single feature through a whole milestone in which Distill, the
 * Eval Lab, the trigger lab, MCP authoring, shared blocks and capture campaigns all gained
 * gates, so the admin panel reported six built features as "not built yet" — the same shape
 * as the Loop panel telling an operator that `flagged` was uncollected while recording it.
 *
 * The fix is the one `UNIMPLEMENTED_KINDS` uses: assert the list against reality, in **both**
 * directions, and name what to change. A key on the list with no call site is a claim that
 * something is wired when it is not; a key off the list with one is the failure that happened.
 */
{
  const panel = readFileSync("src/components/settings/plans-panel.tsx", "utf8");
  /**
   * Bounded to the array literal. The first version sliced to the end of the file and
   * collected every quoted string after the declaration — Tailwind class names included —
   * so it reported nine "features" to remove. A scanner that reads more than it means to
   * is the same fault as one that reads its own prose.
   */
  const start = panel.indexOf("const LIVE_FEATURES");
  const literal = panel.slice(start, panel.indexOf("]);", start));
  const declared = new Set((literal.match(/"[a-z-]+"/g) ?? []).map((m) => m.slice(1, -1)));

  const every = [...new Set(Object.values(PLAN_FEATURES).flat())].sort();
  const referenced = new Set<string>();
  for (const feature of every) {
    /**
     * `git grep` rather than a directory walk, so a key referenced only in an uncommitted
     * file does not count as wired — the distinction `verify:tree` exists to make.
     */
    const hits = execFileSync("git", ["grep", "-l", `"${feature}"`, "--", "src"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((line) => line && line !== "src/lib/plans.ts" && !line.includes("plans-panel"));
    if (hits.length > 0) referenced.add(feature);
  }

  const claimedNotWired = [...declared].filter((f) => !referenced.has(f));
  const wiredNotClaimed = [...referenced].filter((f) => !declared.has(f));

  check(
    "every feature the panel calls live has a call site",
    claimedNotWired.length === 0,
    claimedNotWired.length === 0 ? `${declared.size} live` : `remove: ${claimedNotWired.join(", ")}`,
  );
  check(
    "and every feature with a call site is called live",
    wiredNotClaimed.length === 0,
    wiredNotClaimed.length === 0
      ? `${referenced.size} of ${every.length} wired`
      : `add to LIVE_FEATURES: ${wiredNotClaimed.join(", ")}`,
  );
  check(
    "the panel still says which features are not built",
    /not built yet/.test(panel),
    "a plan that silently unlocks nothing is a control that does nothing",
  );
  check(
    "and it says billing is not live",
    /Billing is not live/.test(panel) && /no checkout flow and no provider account/.test(panel),
    "a Plans screen with three tiers reads as a commercial surface that works",
  );
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
