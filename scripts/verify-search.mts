import "dotenv/config";

import { Client } from "pg";

/**
 * Search is indexed, relevant, and fast enough — measured, not assumed (Doc 2 R7.4, R2.9).
 *
 *   pnpm verify:search
 *
 * Free. Read-only.
 *
 * ## Why re-measure now
 *
 * The `tsvector` + GIN + trigram path was measured at **0.8 ms on a 16K corpus** and never
 * re-timed. The corpus is now three times that. R7.4's target is p95 under 500 ms at 500K,
 * which stays unproven either way — but "unproven at 500K" and "unmeasured at all since it
 * tripled" are different states, and only one of them is honest to leave alone.
 *
 * ## What it actually checks
 *
 * Timing a query is the easy half and the least informative. A sequential scan on 49K rows
 * is still fast in absolute terms, so a green stopwatch would hide the regression that
 * matters: an index quietly stopping being used. So the plan is inspected as well as the
 * clock — `EXPLAIN` must show the GIN index, because that is the property that survives the
 * corpus growing another order of magnitude.
 *
 * The relevance cases are the ones that caught the original bug: `code review` used to return
 * *"AGENTS.md — Cross-Tool Agent Registry"* first, and `kubernets` returned nothing at all.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await c.connect();

const [{ n: corpusSize }] = (
  await c.query<{ n: string }>(`select count(*)::text as n from skills where status = 'indexed'`)
).rows;

console.info(`\nIndexes exist and are the ones the query planner can use`);

const { rows: indexes } = await c.query<{ indexname: string; indexdef: string }>(
  `select indexname, indexdef from pg_indexes where tablename = 'skills'`,
);
const defs = indexes.map((i) => i.indexdef).join("\n");

check(
  "a GIN index on the generated search vector",
  /USING gin \("?search_vector"?\)/.test(defs),
  indexes.find((i) => i.indexdef.includes("search_vector"))?.indexname ?? "absent",
);
check(
  "a trigram index on the name, for typos and partial words",
  /gin_trgm_ops/.test(defs),
  indexes.find((i) => i.indexdef.includes("gin_trgm_ops"))?.indexname ?? "absent",
);
check(
  "a GIN index on categories, so a facet filter is not a scan",
  /USING gin \("?categories"?\)/.test(defs),
);
/**
 * The generated column, asserted as generated.
 *
 * A trigger-maintained vector drifts the first time somebody forgets the trigger or
 * backfills a row directly. `GENERATED ALWAYS AS … STORED` cannot: it is recomputed by
 * Postgres on every write, which is why the migration passed `'english'::regconfig`
 * explicitly — the one-argument form reads a GUC, is only STABLE, and a generated column
 * requires IMMUTABLE.
 */
const { rows: generated } = await c.query<{ is_generated: string; expr: string | null }>(
  `select is_generated, generation_expression as expr from information_schema.columns
   where table_name = 'skills' and column_name = 'search_vector'`,
);
check(
  "the search vector is a generated column, so it cannot drift",
  generated[0]?.is_generated === "ALWAYS",
  generated[0]?.is_generated ?? "missing",
);
check(
  "its regconfig is pinned rather than read from a session setting",
  Boolean(generated[0]?.expr?.includes("english")),
  "the one-argument to_tsvector is only STABLE and cannot be used in a generated column",
);

console.info(`\nThe plan uses the index (the property that survives 10× growth)`);

/**
 * Inspected, not just timed.
 *
 * At 49K rows a sequential scan still answers in a few milliseconds, so a stopwatch alone
 * would report success on a query that had stopped using its index — and would keep
 * reporting success right up to the point where the corpus made it unusable. The plan is
 * the leading indicator; the clock is the lagging one.
 */
const { rows: plan } = await c.query<{ "QUERY PLAN": string }>(
  `explain (format text)
   select s.id from skills s
   where s.status = 'indexed'
     and s.search_vector @@ websearch_to_tsquery('english', 'code review')
   order by ts_rank_cd(s.search_vector, websearch_to_tsquery('english', 'code review'), 32) desc
   limit 20`,
);
const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
check(
  "the full-text query is served by a bitmap index scan, not a sequential scan",
  /Bitmap Index Scan|Index Scan/.test(planText) && !/Seq Scan on skills/.test(planText),
  planText.split("\n")[0]?.trim().slice(0, 80),
);

console.info(`\nRelevance — the cases that caught the original bug`);

type Hit = { slug: string; name: string; rank: number };
async function search(query: string, limit = 5): Promise<Hit[]> {
  const { rows } = await c.query<Hit>(
    `select s.slug, s.name,
            greatest(
              ts_rank_cd(s.search_vector, websearch_to_tsquery('english', $1), 32),
              similarity(s.name, $1)
            ) as rank
     from skills s
     where s.status = 'indexed'
       and (s.search_vector @@ websearch_to_tsquery('english', $1) or s.name % $1)
     order by rank desc, s.quality_score desc nulls last
     limit $2`,
    [query, limit],
  );
  return rows;
}

{
  const hits = await search("code review");
  check(
    "'code review' returns something about reviewing code",
    hits.length > 0 && /review/i.test(hits[0].name),
    hits[0] ? `${hits[0].name} (rank ${Number(hits[0].rank).toFixed(3)})` : "nothing",
  );
}
{
  /**
   * The trigram half, and the reason there are two indexes.
   *
   * `kubernets` is a typo: the tsvector path stems words and cannot match it at all, and
   * before the trigram index this returned **nothing**. The two indexes fail in opposite
   * directions, which is why the query ORs them.
   */
  const hits = await search("kubernets");
  check(
    "a misspelling still finds something (the trigram half)",
    hits.length > 0,
    hits[0] ? hits[0].name : "nothing — the trigram index is not being used",
  );
}
{
  const hits = await search("terraform");
  check(
    "'terraform' ranks a terraform skill first, not a neighbour",
    hits.length > 0 && /terraform/i.test(hits[0].name),
    hits[0] ? hits[0].name : "nothing",
  );
}
{
  const hits = await search("qwertyuiop-not-a-real-thing");
  check(
    "a nonsense query returns nothing rather than the whole corpus",
    hits.length === 0,
    `${hits.length} hits`,
  );
}

console.info(`\nTiming at ${Number(corpusSize).toLocaleString()} indexed skills`);

/**
 * Server-side timing, median of several runs.
 *
 * `EXPLAIN ANALYZE` reports what Postgres spent rather than what the round trip cost, which
 * is the number R7.4's target is about — a laptop's latency to a Neon region would otherwise
 * dominate and tell us about the network instead of the index.
 */
async function timeQuery(query: string, runs = 7): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const { rows } = await c.query<{ "QUERY PLAN": string }>(
      `explain (analyze, format text)
       select s.slug from skills s
       where s.status = 'indexed'
         and (s.search_vector @@ websearch_to_tsquery('english', $1) or s.name % $1)
       order by greatest(
                  ts_rank_cd(s.search_vector, websearch_to_tsquery('english', $1), 32),
                  similarity(s.name, $1)
                ) desc,
                s.quality_score desc nulls last
       limit 20`,
      [query],
    );
    const text = rows.map((r) => r["QUERY PLAN"]).join("\n");
    const match = /Execution Time: ([\d.]+) ms/.exec(text);
    if (match) times.push(Number(match[1]));
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? Number.POSITIVE_INFINITY;
}

const queries = ["code review", "terraform", "kubernets", "generate a report from data"];
let worst = 0;
for (const query of queries) {
  const ms = await timeQuery(query);
  worst = Math.max(worst, ms);
  console.info(`  ${`"${query}"`.padEnd(32)} ${ms.toFixed(1).padStart(7)} ms (median of 7)`);
}

/**
 * A generous ceiling, deliberately.
 *
 * R7.4 wants p95 under 500 ms **at 500K**, and this corpus is a tenth of that. Asserting the
 * target here would either pass trivially or fail for reasons that have nothing to do with
 * the target. What this guards is a *regression* — an index dropped, a plan gone sequential —
 * and 50 ms is far above anything the current path produces while still catching that.
 */
check(
  "no query takes more than 50 ms server-side",
  worst < 50,
  `worst ${worst.toFixed(1)} ms at ${Number(corpusSize).toLocaleString()} skills`,
);

console.info(
  `\n  note  R7.4's p95-at-500K target remains unproven and this does not prove it: the corpus` +
    `\n        is ~10% of that size. What is now measured rather than assumed is that the index` +
    `\n        path still holds at ${Number(corpusSize).toLocaleString()}, up from the 16K it was last timed at.`,
);

await c.end();
console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
