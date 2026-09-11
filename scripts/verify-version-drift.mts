import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  compareVersion,
  DRIFT_STEPS_BEFORE_SURFACING,
  DRIFT_META,
  DRIFT_STATES,
  majorsBehind,
  stepsBehind,
  parseVersion,
  resolveVersioned,
  VERSION_CHECK_STATES,
  VERSIONED,
  VERSIONED_IDS,
} from "../src/lib/versions";
import { EXTRACTOR_VERSION } from "../src/server/analytics/structure";

/**
 * Drift is a fact, never a demotion (Doc 7 RD.10, plan step P5).
 *
 *   pnpm verify:version-drift
 *
 * Free, and no network: the comparison is arithmetic and the stored half reads two tables.
 *
 * ## The three properties this file exists to protect
 *
 * 1. **A newer release changes nothing about a skill's standing.** A document teaching Next 15
 *    idioms is exactly right for a codebase on Next 15. `stale` — a review date somebody set
 *    and let pass — stays the only freshness signal that moves a state, because that one is a
 *    governance decision a human made. The derivation must reach no lifecycle expression.
 * 2. **The vocabulary is the filter, and it filters on read.** `version_pins` holds every
 *    candidate the regex produced, including `if` at 90 repositories. None of it may reach a
 *    reader, and widening the list must cost a query rather than a re-extract.
 * 3. **Every entry was fetched before it was trusted.** Four of the first twenty feeds 404'd.
 *    An entry nothing in the corpus pins is an entry written from memory.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary, and what it refuses to track");

check("every id is unique", new Set(VERSIONED_IDS).size === VERSIONED_IDS.length, `${VERSIONED.length} projects`);
check(
  "every entry has a feed and a comparison precision",
  VERSIONED.every(
    (v) =>
      (v.releases.kind === "github" ? v.releases.repo.includes("/") : v.releases.product.length > 0) &&
      (v.precision === "major" || v.precision === "minor"),
  ),
);
check(
  "every drift state has its own sentence",
  new Set(Object.values(DRIFT_META).map((m) => m.blurb)).size === DRIFT_STATES.length,
  `${DRIFT_STATES.length} states`,
);
/*
 * The most-pinned names in the corpus after the runtimes are standards, and excluding them is
 * the judgement this list turns on: a skill written against WCAG 2.1 does not become wrong
 * when 2.2 ships. Asserted so a future widening has to argue with it rather than drift past.
 */
for (const standard of ["wcag", "oauth", "tls", "openapi", "cvss", "apache"]) {
  check(`\`${standard}\` is not tracked — a standard version is a choice, not staleness`, resolveVersioned(standard) === null);
}
for (const model of ["opus", "sonnet", "haiku", "gemini", "claude"]) {
  check(`\`${model}\` is not tracked — a model id is a setting here, not a thing to nag about`, resolveVersioned(model) === null);
}
check(
  "and the regex noise resolves to nothing",
  ["if", "is", "rate", "count", "ratio", "target", "has", "have", "returns"].every(
    (junk) => resolveVersioned(junk) === null,
  ),
  "`if` is pinned by 90 repositories; the vocabulary is what keeps it off a page",
);
check("while the measured head does resolve", ["python", "node", "next", "go"].every((id) => resolveVersioned(id) !== null));
check("and aliases fold", resolveVersioned("NodeJS") === "node" && resolveVersioned("golang") === "go");

console.info("\nComparison, at the precision the project is versioned by");

check("a patch release is not drift", compareVersion("3.11", "3.11.4", "minor") === "current", "nobody writing against Python 3.11 meant 3.11.4");
check("a minor release is, when minor is the unit", compareVersion("3.11", "3.14.7", "minor") === "behind");
check("and is not, when major is", compareVersion("18", "18.20.0", "major") === "current");
check("a major release is drift", compareVersion("18", "v26.8.2", "major") === "behind");
/*
 * Every tag shape the nineteen verified feeds actually return, on 2026-09-11.
 *
 * Written out because the first version of this check was `parseVersion(x).length === 0 || …`
 * — an `||` whose right-hand side was trivially true, so it passed either way. That is the
 * condition-that-cannot-fail pattern this codebase has a section about, and it was hiding a
 * real hole: an anchored regex returned nothing for `swift-6.3.3-RELEASE`, `php-8.5.10` and
 * `bun-v1.4.2`, so three tracked projects would silently never have produced drift while
 * every check stayed green.
 */
const REAL_TAGS: Array<[string, string]> = [
  ["3.14.7", "3.14.7"],
  ["v26.8.2", "26.8.2"],
  ["swift-6.3.3-RELEASE", "6.3.3"],
  ["php-8.5.10", "8.5.10"],
  ["bun-v1.4.2", "1.4.2"],
  ["v8.1.3.1", "8.1.3.1"],
  ["1.98.1", "1.98.1"],
];
for (const [tag, expected] of REAL_TAGS) {
  check(`\`${tag}\` parses to ${expected}`, parseVersion(tag).join(".") === expected, parseVersion(tag).join(".") || "(nothing)");
}
check(
  "and a tag with no numbers at all is unparseable rather than guessed",
  parseVersion("latest").length === 0 && parseVersion("stable").length === 0,
);
check("a pin shorter than the precision compares on what it has", compareVersion("3", "3.14.7", "minor") === "current");
check("something newer than the feed reads as ahead, not behind", compareVersion("27", "v26.8.2", "major") === "ahead");
check("an unparseable pair is unknown, never a guess", compareVersion("latest", "26", "major") === "unknown");
check("majorsBehind counts majors", majorsBehind("18", "26.8.2") === 8 && majorsBehind("26", "26.8.2") === 0);

/*
 * The threshold has to be denominated in the unit the project actually moves in, and this is
 * the check that caught it not being. A skill pinning `terraform 1.7.0` against a current
 * `1.16.2` is nine releases behind and scores **zero majors** — so under a majors-only
 * threshold it could never surface, and neither could anything pinning `python`, `go`,
 * `rust` or `kubectl`, all of which have lived on one major for years. Half the list was
 * unreachable by construction.
 */
check(
  "a minor-versioned project counts minors, or half the list can never surface",
  stepsBehind("1.7.0", "1.16.2", "minor") === 9,
  `terraform 1.7 → 1.16 is ${stepsBehind("1.7.0", "1.16.2", "minor")} behind, and 0 majors`,
);
check(
  "a major-versioned project still counts majors",
  stepsBehind("18", "26.8.2", "major") === 8,
);
check(
  "a minor bump under major precision is not drift",
  stepsBehind("26.1", "26.8.2", "major") === 0,
);
check(
  "and a major bump under minor precision is well past the threshold on its own",
  (stepsBehind("3.11", "4.0", "minor") ?? 0) >= DRIFT_STEPS_BEFORE_SURFACING,
  "the largest thing that can happen to such a project",
);
check(
  "a pin with no minor part is not behind on minors",
  stepsBehind("3", "3.14", "minor") === 0,
  "the author said 3 and meant 3",
);
check(
  "and one release behind is not surfaced",
  DRIFT_STEPS_BEFORE_SURFACING >= 2,
  `${DRIFT_STEPS_BEFORE_SURFACING} releases — one behind is ordinary and often deliberate`,
);
check("every check state has a name", VERSION_CHECK_STATES.length === 3 && VERSION_CHECK_STATES.includes("blocked"));

console.info("\nDrift demotes nothing");

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const derivation = strip(readFileSync(join(process.cwd(), "src/server/skills/versions.ts"), "utf8"));
check(
  "the derivation touches no lifecycle, quality score or status",
  !/lifecycleExpression|lifecycle_declaration|qualityScore|quality_score|skills\.status/.test(derivation),
  "`stale` stays the only freshness signal that moves a state, because a human set that date",
);
check(
  "and the scan can see a breach",
  /lifecycleExpression/.test(["lifecycle", "Expression("].join("")),
  "assembled at runtime, so the control is neither a literal this scan reports nor an import the tree check does",
);
const lifecycle = strip(readFileSync(join(process.cwd(), "src/lib/lifecycle.ts"), "utf8"));
check(
  "and the lifecycle has never heard of drift",
  !/drift|versionPins|version_pins/.test(lifecycle),
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
  /*
   * Every entry is pinned by something. An id nothing in the corpus references was written
   * from memory rather than from the table — which is exactly what happened to `postgres` in
   * the first draft of this list, and to three of `seeds.ts`'s original entries.
   */
  const { rows: pinnedNames } = await c.query<{ tool: string }>(
    `select distinct p->>'tool' as tool
       from skill_structures s, jsonb_array_elements(s.version_pins) p
      where s.extractor_version = $1`,
    [EXTRACTOR_VERSION],
  );
  const pinned = new Set(pinnedNames.map((r) => r.tool.toLowerCase()));
  const unpinned = VERSIONED.filter(
    (v) => !pinned.has(v.id) && !(v.aliases ?? []).some((a) => pinned.has(a.toLowerCase())),
  );
  check(
    "every tracked project is pinned by at least one skill",
    unpinned.length === 0,
    unpinned.length === 0
      ? `${VERSIONED.length} of ${VERSIONED.length} earn their place`
      : `${unpinned.map((v) => v.id).join(", ")} — written from memory rather than from the table`,
  );

  const { rows: noise } = await c.query<{ n: string }>(
    `select count(distinct p->>'tool')::text as n
       from skill_structures s, jsonb_array_elements(s.version_pins) p
      where s.extractor_version = $1`,
    [EXTRACTOR_VERSION],
  );
  check(
    "and the vocabulary is a filter over a much larger candidate set",
    Number(noise[0].n) > VERSIONED.length * 3,
    `${noise[0].n} distinct pinned names stored, ${VERSIONED.length} tracked — the rest never reaches a reader`,
  );

  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.tool_versions') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  tool_versions absent — pnpm db:generate, read the SQL, then pnpm db:migrate");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'tool_versions'`,
    );
    /*
     * What Node released is not a fact about anybody's workspace, so this is the rare table
     * with no tenant column — safe **because of the column list**, and asserted against the
     * schema rather than today's data, the line `verify:blocks` holds for `skill_blocks`.
     */
    check(
      "no column could tie a release to a workspace, a skill or a customer URL",
      !columns.some((col) => /org|skill|url|user|tenant/.test(col.column_name)),
      columns.map((c2) => c2.column_name).join(" "),
    );
    check(
      "one row per project",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes where tablename = 'tool_versions' and indexdef ilike '%unique%subject%'`,
        )
      ).rows[0].n !== "0",
    );

    const { rows: stored } = await c.query<{ n: string; ok: string }>(
      `select count(*)::text as n, count(*) filter (where status = 'ok')::text as ok from tool_versions`,
    );
    if (stored[0].n === "0") {
      console.info("  skip  nothing checked yet — pnpm versions --check");
    } else {
      check(`releases are stored`, Number(stored[0].ok) > 0, `${stored[0].ok} of ${stored[0].n} answered`);
      const { rows: subjects } = await c.query<{ subject: string }>(`select distinct subject from tool_versions`);
      check(
        "every stored subject is in the vocabulary",
        subjects.every((r) => (VERSIONED_IDS as readonly string[]).includes(r.subject)),
        subjects.map((r) => r.subject).filter((s2) => !(VERSIONED_IDS as readonly string[]).includes(s2)).join(" ") || "all known",
      );

      /*
       * The end-to-end claim, on a real document: a skill that pins an old version reads as
       * behind, and one that pins the current one does not. Reproduced against stored rows
       * rather than a fixture, because the join across two tables and a jsonb array is the
       * part that can silently return nothing — the failure mode the watch feed shipped with.
       */
      const { driftForVersion } = await import("../src/server/skills/versions");
      const { rows: candidate } = await c.query<{ id: string; slug: string; tool: string; version: string }>(
        /*
         * `cross join lateral`, and the alias is declared **before** the join that reads it.
         *
         * The comma form put `jsonb_array_elements(...) p` after the `tool_versions` join, so
         * `p` was not yet in scope in that join's `on` clause and Postgres refused the whole
         * query with *column "p" does not exist*. FROM items are resolved left to right; a
         * lateral that appears later cannot be referenced earlier. The comma reads as though
         * order does not matter, which is exactly why it is spelled out here.
         */
        `select s.skill_version_id as id, sk.slug, p->>'tool' as tool, p->>'version' as version
           from skill_structures s
           join skills sk on sk.id = s.skill_id and sk.current_version_id = s.skill_version_id
           cross join lateral jsonb_array_elements(s.version_pins) p
           join tool_versions tv on tv.subject = lower(p->>'tool') and tv.status = 'ok'
          where s.extractor_version = $1 and sk.status = 'indexed' and sk.org_id is null
          limit 1`,
        [EXTRACTOR_VERSION],
      );
      if (candidate.length === 0) {
        console.info("  skip  no indexed skill pins a tracked project yet");
      } else {
        const drift = await driftForVersion(candidate[0].id);
        check(
          "the derivation runs against a real document rather than asserting the SQL exists",
          Array.isArray(drift),
          `${candidate[0].slug} pins ${candidate[0].tool} ${candidate[0].version} → ${drift.length} surfaced`,
        );
        check(
          "and everything it surfaces is behind by at least the threshold",
          drift.every((d) => d.state === "behind" && (d.stepsBehind ?? 0) >= DRIFT_STEPS_BEFORE_SURFACING),
          drift.map((d) => `${d.subject} ${d.pinned}→${d.current}`).join(", ") || "(nothing surfaced)",
        );
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
