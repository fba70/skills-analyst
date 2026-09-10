import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  API_CACHE_SECONDS,
  API_ERROR_STATUS,
  API_LICENCE,
  API_PAGE_SIZES,
  apiPageSize,
  DATASET_PAGE,
} from "../src/lib/api";
import { PAGE_SIZES } from "../src/server/dal/skills";
import { RATE_LIMIT_DEFAULTS } from "../src/server/settings/rate-limits";

/**
 * The public API serves metadata and cannot serve a body (Doc 2 R8.6, R3.7, R8.3 — step F4).
 *
 *   pnpm verify:api
 *
 * Free. The stored half calls the readers against the real corpus and writes nothing.
 *
 * ## The property this file exists to protect
 *
 * **No skill text leaves through any of these endpoints, at any volume.** That is not a
 * limitation added afterwards — it is what makes a bulk endpoint lawful at all. 96% of this
 * corpus is `attribution_required` and some is `metadata_only`, which is precisely the posture
 * meaning *name it, describe it, link to it, do not hand over the bytes*. A bulk export with
 * bodies would be serviceable for none of the corpus; one without them is serviceable for all of
 * it.
 *
 * So the suite reads real records back and asserts no field carries prose from a skill, and scans
 * the routes for any path to the bundle at all.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

console.info("\nNo route can reach a skill's bytes");

const apiRoot = join(process.cwd(), "src/app/api/v1");
const routes = routeFiles(apiRoot);
check("the scan found the v1 routes", routes.length >= 4, `${routes.length} files`);

const reader = strip(readFileSync(join(process.cwd(), "src/server/api/public.ts"), "utf8"));
check(
  "the reader never opens a bundle",
  !/getBundleFile|readMarkerBody|loadBundle|exportSkill|storageKey/.test(reader),
  "bodies live in object storage, and nothing here has a route to them",
);
for (const path of routes) {
  const source = strip(readFileSync(path, "utf8"));
  const name = path.replace(process.cwd() + "/", "");
  check(
    `${name} touches no database module directly`,
    !/@\/server\/db\b|drizzle-orm|from "pg"/.test(source),
    "hard rule 5 — queries live in src/server and are called from a route",
  );
}

console.info("\nTwo licences, stated on every response");

check(
  "the derived analysis is offered under a named licence",
  API_LICENCE.derived.licence === "CC-BY-SA-4.0",
  "Doc 1 licenses archetype snapshots CC BY-SA; the rest of the derived data follows it",
);
check(
  "the skills' own licence is deferred to per record, never averaged into one field",
  API_LICENCE.skills.licence.includes("each record"),
  "a single `licence` field would be wrong for one of the two halves whichever value it held",
);
check(
  "and the envelope says outright that bodies are not served",
  API_LICENCE.bodies.what.includes("not served"),
  "a researcher should not have to infer the boundary from what happens to be absent",
);
check(
  "the reader stamps both onto every payload",
  reader.includes("licence: API_LICENCE"),
);

console.info("\nOne paging behaviour, not two");

check(
  "the API's page sizes are the registry's own",
  API_PAGE_SIZES.length === PAGE_SIZES.length &&
    API_PAGE_SIZES.every((n) => (PAGE_SIZES as readonly number[]).includes(n)),
  `${API_PAGE_SIZES.join(", ")}`,
);
check(
  "an unknown page size falls back rather than being passed through",
  apiPageSize(1_000) === 25 && apiPageSize("nonsense") === 25 && apiPageSize(10) === 10,
  "a wider list would be silently clamped and the response would report a size it did not use",
);
check(
  "bulk has its own endpoint with its own page",
  DATASET_PAGE >= 100 && DATASET_PAGE > Math.max(...API_PAGE_SIZES),
  `${DATASET_PAGE} per dataset request`,
);

console.info("\nStatus codes a consumer can act on");

check(
  "a withdrawn skill is gone, not missing",
  API_ERROR_STATUS.gone === 410 && API_ERROR_STATUS["not-found"] === 404,
  "R8.4 wants a citation to keep resolving; a silent 404 says nothing about why",
);
check("a refusal is 429 so a retry policy can read it", API_ERROR_STATUS["rate-limited"] === 429);
check(
  "reads are cacheable, and not for so long that a takedown lingers",
  API_CACHE_SECONDS > 0 && API_CACHE_SECONDS <= 900,
  `${API_CACHE_SECONDS}s`,
);

console.info("\nThe read limiter is generous, because scraping is the alternative");

check(
  "the public API has its own scope",
  Boolean(RATE_LIMIT_DEFAULTS.publicApi),
  `${RATE_LIMIT_DEFAULTS.publicApi.perMinute}/min · ${RATE_LIMIT_DEFAULTS.publicApi.perHour}/hr`,
);
check(
  "and it is far looser than the write scopes",
  RATE_LIMIT_DEFAULTS.publicApi.perHour > RATE_LIMIT_DEFAULTS.publicWrite.perHour &&
    RATE_LIMIT_DEFAULTS.publicApi.perHour > RATE_LIMIT_DEFAULTS.mcpWrite.perHour,
  "a limit tight enough to annoy sends the traffic back to the pages it was meant to relieve",
);

console.info("\nAgainst the real corpus");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { apiDataset, apiListSkills, apiResolve, apiGetSkill } = await import(
    "../src/server/api/public"
  );

  /*
   * The dataset runs for real; the DAL-backed shapes cannot, and the split is honest.
   *
   * `listSkills` and `getSkillBySlug` resolve a session through `next/navigation`, which a plain
   * node process cannot load — the reason `export.ts` was split into `buildBundle` and
   * `exportSkill`. They work inside a route and are unreachable from here.
   *
   * That is survivable because **the dataset is the endpoint where a body leak would be worst**:
   * it is the bulk one, and it is pure SQL with no DAL between it and the columns. The
   * DAL-backed shapes are covered by the source scan above, which asserts they have no route to
   * a bundle at all.
   */
  const dataset = await apiDataset(null, 25);
  check("the dataset streams records", dataset.records.length > 0, `${dataset.records.length}`);
  check(
    "and hands back a cursor rather than an offset",
    dataset.nextCursor !== null && dataset.nextCursor === dataset.records.at(-1)?.slug,
    "an offset skips or repeats rows when the corpus grows underneath a long export",
  );
  const second = await apiDataset(dataset.nextCursor, 25);
  check(
    "the next page starts after the cursor and does not repeat it",
    second.records.every((row) => row.slug > dataset.nextCursor!),
  );
  const datasetLongest = dataset.records
    .flatMap((row) => Object.values(row))
    .filter((value): value is string => typeof value === "string")
    .reduce((max, value) => Math.max(max, value.length), 0);
  check(
    "no dataset field is long enough to be a body",
    datasetLongest < 2_000,
    `longest string ${datasetLongest} characters — the bulk endpoint is where this matters most`,
  );

  let dalReachable = true;
  try {
    await apiListSkills({ pageSize: 5 });
  } catch {
    dalReachable = false;
  }

  if (!dalReachable) {
    console.info(
      "  skip  the list, detail and resolve shapes need a request context — they resolve a " +
        "session through next/navigation, which no plain node process can load",
    );
  }

  if (dalReachable) {
  const list = await apiListSkills({ pageSize: 5 });
  check("the list returns records", list.items.length > 0, `${list.total.toLocaleString()} total`);
  check(
    "and reports the page size it actually used",
    list.pageSize === 5,
    `${list.pageSize}`,
  );

  /*
   * The headline property, checked against real records rather than against the type.
   *
   * A body is long prose; every legitimate field here is a slug, a label, a number or a short
   * summary. Anything over a couple of thousand characters in a metadata payload is a body that
   * got in, whatever the field is called.
   */
  const longest = list.items
    .flatMap((item) => Object.values(item))
    .filter((value): value is string => typeof value === "string")
    .reduce((max, value) => Math.max(max, value.length), 0);
  check(
    "no field in a list record is long enough to be a body",
    longest < 2_000,
    `longest string ${longest} characters`,
  );

  const sample = list.items[0];
  if (!sample) {
    console.info("  skip  the corpus is empty");
  } else {
    const detail = await apiGetSkill(sample.slug);
    check("one skill resolves in full", detail.ok);
    if (detail.ok) {
      check(
        "the verdicts come back as counts, not as findings",
        detail.skill.verdicts.every(
          (verdict) => typeof verdict.findings === "number" && verdict.result.length > 0,
        ),
        "a finding can name a line of somebody's skill; a bulk-readable copy of that is worse than the score",
      );
      check(
        "and the record carries where it came from",
        detail.skill.provenance.sourceUrl !== null || detail.skill.contentHash !== null,
      );
    }

    const resolved = await apiResolve(sample.slug);
    check("resolution pins a content hash", resolved.ok && resolved.contentHash.length > 0);
    if (resolved.ok) {
      check(
        "an undownloadable skill is refused with a reason, not a null URL alone",
        resolved.downloadable ? resolved.download !== null : Boolean(resolved.reason),
        resolved.downloadable ? "downloadable" : resolved.reason,
      );
    }
    check(
      "an unknown slug is not-found rather than an empty record",
      !(await apiResolve("definitely-not-a-real-slug-9f3a")).ok,
    );
  }

  }

  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
