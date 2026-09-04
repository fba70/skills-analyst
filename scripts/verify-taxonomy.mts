import "dotenv/config";

import { Client } from "pg";

import {
  DOMAINS,
  FUNCTIONS,
  isValidCategory,
  TAXONOMY_VERSION,
  type Category,
} from "../src/server/taxonomy/vocabulary";

/**
 * The vocabulary is internally consistent and agrees with what is stored.
 *
 *   pnpm verify:taxonomy
 *
 * Free — reads the vocabulary module and the categories table, calls no model.
 *
 * ## Why this exists
 *
 * Two failures on 2026-09-04, both invisible until someone paid to find them.
 *
 * A **naming inconsistency** cost the most: `productivity-personal` was inverted where every
 * other id reads as natural English, so the classifier kept proposing
 * `personal-productivity`, the id was dropped as invalid, the skill lost an axis and was
 * rejected. It was **29 of 64 invalid proposals — 45% of everything we refused** — and it was
 * only discovered by running 500 skills through the model and tallying what it asked for.
 *
 * A **rename without a migration** would have been the mirror image: edit the id in
 * TypeScript, leave 604 rows holding a value the vocabulary no longer contains, and watch
 * them fail validation silently on read. `skill_categories.value` is plain `text`, so nothing
 * in the database would object.
 *
 * Both are cheap to check and were expensive to find.
 */

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

await c.connect();

console.info(`\nVocabulary shape (${TAXONOMY_VERSION})`);

const all: Array<{ axis: "function" | "domain"; c: Category }> = [
  ...FUNCTIONS.map((x) => ({ axis: "function" as const, c: x })),
  ...DOMAINS.map((x) => ({ axis: "domain" as const, c: x })),
];

const ids = all.map((x) => `${x.axis}:${x.c.id}`);
check("no duplicate ids", new Set(ids).size === ids.length);
check(
  "every id is lower-case kebab",
  all.every((x) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.c.id)),
  all.filter((x) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.c.id)).map((x) => x.c.id).join(", "),
);
check(
  "every entry has a label and a description",
  all.every((x) => x.c.label.trim().length > 0 && x.c.description.trim().length > 20),
);

/**
 * Segment-order collisions — the `productivity-personal` / `personal-productivity` trap.
 *
 * Two ids built from the same words in a different order are one concept spelled two ways.
 * Nobody would add both deliberately; the failure is adding one whose *natural* order is the
 * other, which is what happened, and the model then writes the natural one.
 */
const byShape = new Map<string, string[]>();
for (const x of all) {
  const key = `${x.axis}:${x.c.id.split("-").sort().join("-")}`;
  byShape.set(key, [...(byShape.get(key) ?? []), x.c.id]);
}
const collisions = [...byShape.values()].filter((v) => v.length > 1);
check("no two ids are the same words reordered", collisions.length === 0, collisions.map((v) => v.join(" / ")).join(", "));

console.info("\nThe vocabulary agrees with what is stored");

const stored = await c.query<{ axis: "function" | "domain"; value: string; n: string }>(
  `select axis::text as axis, value, count(*)::text as n from skill_categories group by 1, 2`,
);
const orphans = stored.rows.filter((r) => !isValidCategory(r.axis, r.value));
check(
  "no stored assignment holds an id outside the vocabulary",
  orphans.length === 0,
  orphans.map((o) => `${o.axis}:${o.value}(${o.n})`).join(", "),
);

/**
 * The denormalised read path is where an orphan actually hurts: `skills.categories` is what
 * the registry filters and facets on, so a stale id there is a browse entry that matches
 * nothing and explains nothing.
 */
const arrays = await c.query<{ value: string; n: string }>(
  `select distinct v as value, count(*)::text as n
     from skills, unnest(categories) as v
    where org_id is null group by v`,
);
const arrayOrphans = arrays.rows.filter((r) => !isValidCategory("domain", r.value) && !isValidCategory("function", r.value));
check(
  "no skills.categories entry is outside the vocabulary",
  arrayOrphans.length === 0,
  arrayOrphans.map((o) => `${o.value}(${o.n})`).join(", "),
);

console.info(`\n${pass} passed, ${fail} failed\n`);
await c.end();
process.exit(fail > 0 ? 1 : 0);
