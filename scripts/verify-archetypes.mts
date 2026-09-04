import "dotenv/config";

import { Client } from "pg";

import { MINER_VERSION } from "../src/server/analytics/archetype";
import { SECTION_ROLES } from "../src/server/analytics/structure";

/**
 * Stored archetypes carry usable, attributed, self-explaining guidance.
 *
 *   pnpm verify:archetypes
 *
 * Free — reads stored rows, mines nothing, calls no model.
 *
 * ## Why this exists
 *
 * On 2026-09-04 a re-mine over the newly-labelled corpus produced **five archetypes with
 * zero sections** and eight more with one or two. Nothing errored: `--mine-all` printed
 * thirteen ticks and a list of dropped sections, and `/build` and `/archetypes` served the
 * result. The regression was visible only to someone who read the summary closely and
 * thought the drops looked odd.
 *
 * The cause turned out to be real — at 97% coverage the weak band writes `steps` and
 * `references` almost as often as the curated band, so section presence stopped
 * discriminating — but "the measurement is correct" and "the output is usable" are different
 * questions, and only the first had an answer. An archetype with no sections and no traits
 * scaffolds nothing, and the builder would keep offering it.
 *
 * So the invariant is not "sections exist". It is **something usable exists**, plus the
 * things that make a published claim auditable: who it came from, and what was measured to
 * produce it.
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

type Row = {
  category: string;
  version: number;
  miner_version: string;
  sections: number;
  traits: number;
  contributors: number;
  measured: number;
  roles: string[] | null;
  kept_not_in_measured: number;
};

const { rows } = await c.query<Row>(`
  select a.category, a.version, a.miner_version,
    jsonb_array_length(coalesce(a.skeleton->'sections','[]'::jsonb)) as sections,
    jsonb_array_length(coalesce(a.skeleton->'traits','[]'::jsonb)) as traits,
    jsonb_array_length(coalesce(a.stats->'contributors','[]'::jsonb)) as contributors,
    jsonb_array_length(coalesce(a.stats->'measured','[]'::jsonb)) as measured,
    (select array_agg(s->>'role') from jsonb_array_elements(a.skeleton->'sections') s) as roles,
    (select count(*) from jsonb_array_elements(a.skeleton->'sections') s
      where not exists (
        select 1 from jsonb_array_elements(a.stats->'measured') m where m->>'role' = s->>'role'
      ))::int as kept_not_in_measured
  from archetypes a
  where a.org_id is null
    and a.version = (select max(version) from archetypes b
                      where b.category = a.category and b.org_id is null and b.axis = a.axis)
  order by a.category
`);

console.info(`\nLatest archetype per category (${rows.length} rows)`);

check("every latest row is at the current miner", rows.every((r) => r.miner_version === MINER_VERSION),
  rows.filter((r) => r.miner_version !== MINER_VERSION).map((r) => `${r.category}@${r.miner_version}`).join(", "));

/**
 * The invariant that actually protects the product. Sections may legitimately be zero — the
 * corpus is allowed to have no structural consensus — but a row with neither sections nor
 * traits scaffolds an empty form and teaches nothing.
 */
const useless = rows.filter((r) => r.sections + r.traits === 0);
check("every archetype carries sections or traits", useless.length === 0,
  useless.map((r) => r.category).join(", "));

check("every archetype is attributed (R3.4)", rows.every((r) => r.contributors > 0),
  rows.filter((r) => r.contributors === 0).map((r) => r.category).join(", "));

/**
 * The evidence behind the skeleton, including the rejects. Without it a section that missed
 * the threshold by two points is indistinguishable from one never considered.
 */
check("every archetype stores what it measured", rows.every((r) => r.measured > 0),
  rows.filter((r) => r.measured === 0).map((r) => r.category).join(", "));

check("every kept section appears in the measurements", rows.every((r) => r.kept_not_in_measured === 0),
  rows.filter((r) => r.kept_not_in_measured > 0).map((r) => r.category).join(", "));

const validRoles = new Set<string>(SECTION_ROLES as readonly string[]);
const badRole = rows.filter((r) => (r.roles ?? []).some((x) => !validRoles.has(x)));
check("every skeleton role is in the section vocabulary", badRole.length === 0,
  badRole.map((r) => `${r.category}:${(r.roles ?? []).filter((x) => !validRoles.has(x)).join("/")}`).join(", "));

/**
 * Append-only. A regeneration writes a new row; it never edits the previous one, which is
 * what makes R7.2 reproducibility and R3.5 evolution-diffing possible at all.
 */
const { rows: dupes } = await c.query<{ n: string }>(
  `select count(*)::text as n from (
     select category, version from archetypes where org_id is null
     group by category, version, axis having count(*) > 1) t`,
);
check("no category/version is written twice", dupes[0].n === "0", `${dupes[0].n} duplicated`);

const { rows: hist } = await c.query<{ n: string }>(
  `select count(*)::text as n from archetypes where org_id is null`,
);
check("earlier versions are retained as history", Number(hist[0].n) > rows.length,
  `${hist[0].n} rows across ${rows.length} categories`);

console.info(`\n${pass} passed, ${fail} failed\n`);
await c.end();
process.exit(fail > 0 ? 1 : 0);
