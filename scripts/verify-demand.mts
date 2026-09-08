import "dotenv/config";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  demandLabel,
  isPublishable,
  LOW_RESULT_THRESHOLD,
  MAX_QUERY_CHARS,
  MIN_DISTINCT_SEARCHERS,
  MIN_QUERY_CHARS,
  normaliseQuery,
  SEARCH_CHANNELS,
} from "../src/lib/demand";

/**
 * Demand signals publish a gap, never a person (Doc 6 RK.5, Doc 2 R5.3, plan step E3).
 *
 *   pnpm verify:demand
 *
 * Free. No model, no network. The rows it writes carry a probe marker and are removed in a
 * `finally`.
 *
 * ## What is actually at risk
 *
 * This is the only feature in the product that takes **user-typed text** and puts it on a
 * **public page**. Everything else published here is either our own vocabulary or somebody's
 * deliberately published document. `"review our acme corp msa for renewal terms"` is a demand
 * signal and also somebody's Monday morning, and the distance between those two is one missing
 * `HAVING` clause.
 *
 *   1. **A query published because one person typed it.** The floor is the whole safety property.
 *   2. **An identity in the table.** There is deliberately no column for one, and that has to
 *      stay true through the next migration rather than through somebody remembering.
 *   3. **A floor that cannot be reached.** The first version keyed anonymous web searches to a
 *      shared constant, which would have made the board permanently empty for a reason that
 *      looked like caution — the mirror image of risk 1, and much harder to notice.
 */

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function skip(name: string, why: string): void {
  console.info(`  skip  ${name} — ${why}`);
  skipped += 1;
}

// ---------------------------------------------------------------------------------------
console.info("\nWhat gets stored at all");
// ---------------------------------------------------------------------------------------

check(
  "case and spacing collapse, so one demand signal is one row",
  normaliseQuery("  Terraform   Review ") === "terraform review" &&
    normaliseQuery("terraform review") === "terraform review",
);
check(
  "trailing punctuation is dropped",
  normaliseQuery("terraform review?") === "terraform review",
);
check(
  "a keystroke on the way to a query is not a query",
  normaliseQuery("te") === null,
  `under ${MIN_QUERY_CHARS} characters`,
);
check(
  "and a pasted document is not demand",
  normaliseQuery("x".repeat(MAX_QUERY_CHARS + 1)) === null,
  `over ${MAX_QUERY_CHARS} characters`,
);
check(
  "punctuation and digits alone are not demand",
  normaliseQuery("!!! ???") === null && normaliseQuery("12345") === null,
  "awkward to explain on a public page later",
);
check("both channels are recorded", SEARCH_CHANNELS.length === 2, SEARCH_CHANNELS.join(", "));

// ---------------------------------------------------------------------------------------
console.info("\nThe floor, which is the whole safety property");
// ---------------------------------------------------------------------------------------

/**
 * Reproduced first: without a floor, one person's search is a public page.
 *
 * The naive board is `select query, count(*) where result_count = 0 group by query order by
 * count(*) desc` — and it publishes a query somebody typed once. That is not a subtle failure
 * mode; it is the feature working exactly as written.
 */
{
  const oneSearcher = { searchers: 1 };
  check(
    "a query asked by one person would clear a naive count-based rule",
    oneSearcher.searchers >= 1,
    "which is the rule anybody writes first",
  );
  check("and is refused by the real one", !isPublishable(oneSearcher));
  check(
    `${MIN_DISTINCT_SEARCHERS} separate searchers is the bar`,
    !isPublishable({ searchers: MIN_DISTINCT_SEARCHERS - 1 }) &&
      isPublishable({ searchers: MIN_DISTINCT_SEARCHERS }),
  );
}

check(
  "nothing found and a thin result read differently",
  demandLabel(0) === "unmet" && demandLabel(LOW_RESULT_THRESHOLD) === "thin",
);

// ---------------------------------------------------------------------------------------
console.info("\nThe schema cannot answer 'who wanted this'");
// ---------------------------------------------------------------------------------------

/**
 * Asserted against the source and, below, against `information_schema`.
 *
 * Every other org-scoped table here carries an `org_id` because knowing whose row it is makes it
 * safe. This one has none, and the absence *is* the safety property — so it has to survive the
 * next migration through a check rather than through somebody remembering the argument.
 */
{
  const schema = readFileSync("src/server/db/schema/demand.ts", "utf8");
  check(
    "the table declares no organisation, user or address column",
    !/orgId|userId|ipAddress|createdBy/.test(schema),
    "'what did this customer search for' is a question with no join",
  );
  check(
    "and the digest rotates daily, so yesterday cannot be recomputed from today",
    /callerDigest/.test(schema) && /rotating/i.test(schema),
  );

  const analytics = readFileSync("src/server/analytics/demand.ts", "utf8");
  /*
   * The floor has to be in the SQL. Applied only after the rows come back, any caller that
   * forgets — a CLI, a future API — reads the unfloored set, and the one that forgets is the one
   * nobody reviewed.
   */
  check(
    "the board's floor is a HAVING clause, not a filter the caller applies",
    /having count\(distinct caller_digest\) >= /.test(analytics),
  );
  check(
    "and it is re-applied on the way out",
    (analytics.match(/\.filter\(isPublishable\)/g) ?? []).length >= 2,
    "a HAVING clause is one keystroke from a disclosure",
  );
  check(
    "the raw query text is never stored, only the normalised form",
    /normaliseQuery\(/.test(analytics) && !/rawQuery|input\.query,\s*$/m.test(analytics),
  );
}

/*
 * The reachability half. `callerDigest(null)` is a single shared constant, so a surface that
 * passes null can never contribute distinct searchers — the board would be permanently empty for
 * a reason that looks like caution. Both surfaces must pass a real key.
 */
{
  const web = readFileSync("src/app/(public)/skills/page.tsx", "utf8");
  check(
    "the web surface passes a caller key rather than null",
    /x-forwarded-for/.test(web) && /channel: "web"/.test(web),
    "callerDigest(null) is one shared constant — the floor would be unreachable",
  );
  check(
    "and only records the first page, so paging is not extra demand",
    /result\.page === 1/.test(web),
  );

  const mcp = readFileSync("src/server/mcp/tools.ts", "utf8");
  check(
    "the agent surface passes its own caller key",
    /channel: "mcp"/.test(mcp) && /callerKey: callerKeyOf\(ctx\)/.test(mcp),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nAgainst the real table");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("table checks", "no database connection — the checks above are complete without it");
}

const PROBE = "verify demand probe query";
/* Guards the cleanup: a `finally` that assumes the table exists fails louder than the skip. */
let tableExists = false;

if (connected) {
  try {
    const exists = await owner.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name = 'search_queries'`,
    );

    tableExists = exists.rows[0].n !== "0";

    if (!tableExists) {
      skip("table checks", "search_queries does not exist — apply migrations/0038");
    } else {
      const columns = (
        await owner.query<{ column_name: string }>(
          `select column_name from information_schema.columns where table_name = 'search_queries'`,
        )
      ).rows.map((row) => row.column_name);

      check(
        "no column on the table can identify anybody",
        !columns.some((name) => /org|user|ip|email|token|session/.test(name)),
        columns.join(", "),
      );

      const indexes = (
        await owner.query<{ indexdef: string }>(
          `select indexdef from pg_indexes where tablename = 'search_queries'`,
        )
      ).rows;
      check(
        "one row per searcher per query per channel per day",
        indexes.some(
          (r) =>
            /UNIQUE/.test(r.indexdef) &&
            /query/.test(r.indexdef) &&
            /caller_digest/.test(r.indexdef) &&
            /day/.test(r.indexdef),
        ),
        "counting rows is the deduplicated count, with no counter to drift",
      );

      const { recordSearch, mostWanted, unmetNear, demandSummary } = await import(
        "../src/server/analytics/demand"
      );

      /**
       * Written through the real recorder and read back.
       *
       * `recordSearch` swallows its own failures, which is the right posture for something a
       * reader's page depends on and is exactly how `recordUsage` silently metered nothing for a
       * milestone. A hand-written insert would prove the table works and nothing about whether
       * the function meant to fill it does.
       */
      const before = Number(
        (await owner.query(`select count(*)::int n from search_queries where query = $1`, [PROBE]))
          .rows[0].n,
      );
      await recordSearch({ query: PROBE, resultCount: 0, channel: "web", callerKey: "probe-1" });
      const after = Number(
        (await owner.query(`select count(*)::int n from search_queries where query = $1`, [PROBE]))
          .rows[0].n,
      );
      check("the recorder actually writes a row", after === before + 1);

      await recordSearch({ query: PROBE, resultCount: 0, channel: "web", callerKey: "probe-1" });
      const twice = Number(
        (await owner.query(`select count(*)::int n from search_queries where query = $1`, [PROBE]))
          .rows[0].n,
      );
      check(
        "and the same searcher asking twice in a day is one row",
        twice === after,
        "the unique index is the dedup; there is no counter to forget",
      );

      /*
       * One searcher must not reach the board. Asserted before adding the rest, because a board
       * that happened to be empty for another reason would pass this trivially.
       */
      const withOne = await mostWanted({ limit: 100 });
      check(
        "one searcher does not put a query on the public board",
        !withOne.some((row) => row.query === PROBE),
        "the floor, doing the only job it has",
      );

      for (let i = 2; i <= MIN_DISTINCT_SEARCHERS; i += 1) {
        await recordSearch({
          query: PROBE,
          resultCount: 0,
          channel: "web",
          callerKey: `probe-${i}`,
        });
      }

      const withFloor = await mostWanted({ limit: 100 });
      const row = withFloor.find((entry) => entry.query === PROBE);
      check(
        `and ${MIN_DISTINCT_SEARCHERS} separate searchers do`,
        row !== undefined && row.searchers === MIN_DISTINCT_SEARCHERS,
        `${row?.searchers} searchers, median ${row?.medianResults} results`,
      );
      check(
        "reported as unmet, because the median result count is zero",
        row?.medianResults === 0 && demandLabel(row?.medianResults ?? 1) === "unmet",
      );

      /*
       * A query the corpus answers must drop off, however many people asked. The board is about
       * gaps, not about popularity — and this is the check that keeps those apart.
       */
      for (let i = 1; i <= MIN_DISTINCT_SEARCHERS; i += 1) {
        await owner.query(
          `update search_queries set result_count = 40 where query = $1 and caller_digest in (
             select caller_digest from search_queries where query = $1
           )`,
          [PROBE],
        );
      }
      const answered = await mostWanted({ limit: 100 });
      check(
        "a query the corpus answers leaves the board however many asked",
        !answered.some((entry) => entry.query === PROBE),
        "this is a gap board, not a popularity board",
      );

      /* R5.3's half: the same rows, matched against an author's purpose. */
      await owner.query(`update search_queries set result_count = 0 where query = $1`, [PROBE]);
      const near = await unmetNear("verify demand probe", 5);
      check(
        "an author's purpose finds overlapping unmet demand",
        near.some((entry) => entry.query === PROBE),
        `${near.length} match(es) — this is the half of R5.3 similarity could not do`,
      );

      const summary = await demandSummary();
      check(
        "the summary can say what the board is a statement about",
        summary.searches > 0 && summary.since instanceof Date,
        `${summary.searches} searches since ${summary.since?.toISOString().slice(0, 10)}`,
      );
    }
  } finally {
    if (tableExists) {
      await owner.query(`delete from search_queries where query = $1`, [PROBE]);
    }
    await owner.end().catch(() => undefined);
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
