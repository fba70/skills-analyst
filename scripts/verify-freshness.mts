import "dotenv/config";

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { Client } from "pg";

import {
  classifyLink,
  DUE_SOON_DAYS,
  isCheckableUrl,
  isRotten,
  LINK_STATUSES,
  RECHECK_AFTER_HOURS,
  reviewUrgency,
  ROT_THRESHOLD,
} from "../src/lib/freshness";

/**
 * Freshness reports decay it can be sure of (Doc 6 RK.2, plan step E1).
 *
 *   pnpm verify:freshness
 *
 * Free. The link checks run against a local server this file starts and stops, so no third party
 * is contacted; the database half writes nothing that is not removed in a `finally`.
 *
 * ## What is actually at risk
 *
 * This is the first surface that accuses somebody else's website of being broken, and the second
 * that tells an author their work needs attention. Four ways it becomes noise:
 *
 *   1. **A transient failure reported as rot.** A deploy, a rate limit and a flaky CDN edge look
 *      identical to one request. A panel that cried wolf on any of them would be ignored inside a
 *      week — the alarm-nobody-can-silence problem, arriving from the other direction.
 *   2. **A 403 read as a dead page.** That is the site refusing *us*. Listing it asks an author to
 *      fix our user agent.
 *   3. **Every undated skill listed as overdue.** A review date is a decision somebody made; not
 *      having made one is not a backlog, and the alternative is a queue 49,000 long.
 *   4. **A dead-link count with no coverage beside it.** "4 dead links" over a corpus 3% checked
 *      reads as a healthy corpus, which is the `archetypes --blocks` misreading exactly.
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
console.info("\nWhat counts as rot, and what does not");
// ---------------------------------------------------------------------------------------

/**
 * The failure reproduced first: the naive rule calls any non-200 a dead link.
 *
 * It is the obvious implementation and it fills the panel with sites that dislike robots. 403 and
 * 429 are the server refusing *this crawler*; a timeout is the network. None of them is the page
 * saying it is gone, and only the page can say that.
 */
{
  const naiveBroken = (code: number | null) => code === null || code >= 400;
  check(
    "the naive rule calls a 403 and a timeout dead",
    naiveBroken(403) && naiveBroken(null),
    "one is the site refusing us, the other is the network",
  );
  check(
    "classification does not",
    classifyLink(403) === "blocked" && classifyLink(null) === "unreachable",
    `403 → ${classifyLink(403)}, no response → ${classifyLink(null)}`,
  );
  check(
    "only 404 and 410 are the page itself saying it is gone",
    classifyLink(404) === "broken" && classifyLink(410) === "broken",
  );
  check(
    "a 500 is the server having a bad day, not a missing page",
    classifyLink(500) === "unreachable",
  );
  check("and a 200 is fine", classifyLink(200) === "ok" && classifyLink(301) === "ok");
  check(
    "four statuses, because ok/broken cannot express the other two",
    LINK_STATUSES.length === 4,
    LINK_STATUSES.join(", "),
  );
}

/*
 * One failure is not rot, and only a `broken` one ever becomes rot however often it repeats.
 */
{
  check(
    "a single 404 is not yet reported",
    !isRotten("broken", 1) && ROT_THRESHOLD >= 2,
    `${ROT_THRESHOLD} consecutive`,
  );
  check("two are", isRotten("broken", ROT_THRESHOLD));
  check(
    "and no number of blocked or unreachable checks ever is",
    !isRotten("blocked", 99) && !isRotten("unreachable", 99),
    "repetition does not turn a fact about us into a fact about the link",
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nWhat is worth fetching at all");
// ---------------------------------------------------------------------------------------

for (const [url, want, why] of [
  ["https://docs.anthropic.com/skills", true, ""],
  ["http://localhost:3000/x", false, "somebody's development notes"],
  ["https://192.168.1.4/api", false, "a private address"],
  ["https://example.com/thing", false, "a placeholder by RFC"],
  ["https://api.example.com/users", false, "a subdomain of one — most of the first real pass"],
  ["https://attacker-server.example.com/steal", false, "likewise, in a security skill"],
  ["http://burpsuite", false, "no dot: an internal name or a word after http://"],
  ["http://model_a", false, "likewise"],
  ["https://thing.invalid/x", false, "RFC 6761 reserved"],
  ["https://${BASE_URL}/api", false, "a template variable"],
  ["https://<your-host>/api", false, "a placeholder somebody left in"],
  ["mailto:someone@example.org", false, "not an http URL"],
  ["not a url at all", false, "not a URL"],
] as const) {
  check(
    `${want ? "checks" : "skips"} ${url}${why ? ` — ${why}` : ""}`,
    isCheckableUrl(url) === want,
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nExtraction");
// ---------------------------------------------------------------------------------------

{
  const { extractLinks } = await import("../src/server/skills/links");

  /*
   * Trailing punctuation is part of the sentence. It matters more here than it looks: a URL with
   * a stray full stop 404s, and a 404 is the one verdict this module treats as confident.
   */
  const links = extractLinks(
    "See [the docs](https://docs.example.dev/a). Also https://api.example.dev/b, and " +
      "`https://x.example.dev/c` in a fence.\nlocalhost://nope http://localhost:1/x",
  );
  check(
    "a link followed by a full stop is not fetched with the full stop",
    links.includes("https://docs.example.dev/a"),
    links.join(" "),
  );
  check(
    "a link followed by a comma likewise",
    links.includes("https://api.example.dev/b"),
  );
  check(
    "a link inside a code fence is still a link the author put there",
    links.includes("https://x.example.dev/c"),
  );
  check("and localhost is not followed", !links.some((l) => l.includes("localhost")));
  check("duplicates collapse", new Set(links).size === links.length);
}

// ---------------------------------------------------------------------------------------
console.info("\nAgainst a real server");
// ---------------------------------------------------------------------------------------

/**
 * A local server, so the check is real without contacting anybody.
 *
 * `verify:http-deadline` set this pattern: reproduce the condition against something you control
 * rather than asserting about code you have read. The `405` route is the one that matters — a
 * great many servers refuse `HEAD`, and reading that as a dead page would be the single largest
 * source of false rot.
 */
{
  const server = createServer((req, res) => {
    if (req.url === "/gone") res.writeHead(404);
    else if (req.url === "/refused") res.writeHead(403);
    else if (req.url === "/no-head") res.writeHead(req.method === "HEAD" ? 405 : 200);
    else res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const { checkLink } = await import("../src/server/skills/links");

    const ok = await checkLink(`${base}/fine`);
    check("a live page reads as ok", ok.status === "ok", `${ok.statusCode}`);

    const gone = await checkLink(`${base}/gone`);
    check("a 404 reads as gone", gone.status === "broken", `${gone.statusCode}`);

    const refused = await checkLink(`${base}/refused`);
    check("a 403 reads as blocked, not gone", refused.status === "blocked", `${refused.statusCode}`);

    /*
     * The HEAD fallback, exercised end to end. Without it this server's `/no-head` would be
     * recorded as a failure on every skill that links to anything hosted like it.
     */
    const awkward = await checkLink(`${base}/no-head`);
    check(
      "a server that refuses HEAD is retried with GET rather than written off",
      awkward.status === "ok",
      `${awkward.statusCode} after the fallback`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------------------
console.info("\nThe review queue");
// ---------------------------------------------------------------------------------------

{
  const now = new Date("2026-09-10T00:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);

  check("no date is not urgency", reviewUrgency(null, now) === null, "not a backlog");
  check("a past date is overdue", reviewUrgency(at(-1), now) === "overdue");
  check(
    "a date inside the window is due soon",
    reviewUrgency(at(DUE_SOON_DAYS - 1), now) === "due-soon",
    `${DUE_SOON_DAYS}-day window`,
  );
  check("a distant one is merely scheduled", reviewUrgency(at(90), now) === "scheduled");

  /*
   * The selector must never return undated skills. Asserted against the source because it is the
   * difference between a queue somebody works and a list of the whole corpus.
   */
  const src = readFileSync("src/server/skills/lifecycle.ts", "utf8");
  check(
    "and the queue selects only skills that have a date",
    /review_by.*is not null|\$\{skills\.reviewBy\} is not null/.test(src),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nThe threshold has to be reachable");
// ---------------------------------------------------------------------------------------

/**
 * The flaw the first real pass exposed, pinned so it cannot come back.
 *
 * Rot needs `ROT_THRESHOLD` consecutive failures. A selector that only walks oldest-first returns
 * to a document once per sweep of the corpus — months, at a couple of hundred a pass over 49,000
 * — so a link that 404s twice never gets asked twice. The first pass found 50 links returning 404
 * and could report none of them, and nothing in the code said why.
 *
 * A document with an outstanding failure now jumps the queue after `RECHECK_AFTER_HOURS`. That is
 * the only path by which anything ever becomes reportable, which is worth a check that names it.
 */
{
  const src = readFileSync("src/server/skills/links.ts", "utf8");
  check(
    "a document with an unconfirmed failure is re-checked ahead of the queue",
    /consecutive_failures > 0/.test(src) && /RECHECK_AFTER_HOURS/.test(src),
    `${ROT_THRESHOLD} failures needed, re-checked after ${RECHECK_AFTER_HOURS}h`,
  );
  check(
    "and only ones short of the threshold — a confirmed rot needs no more evidence",
    /consecutive_failures < \$\{ROT_THRESHOLD\}/.test(src),
  );
  /*
   * Coverage is still the second key. Losing it would mean a corpus that only ever re-checks the
   * documents it has already seen fail — perfect confirmation, no discovery.
   */
  check(
    "coverage remains the fallback ordering",
    /asc nulls first/.test(src),
  );

  check(
    "stale rows are pruned when the extraction rules change",
    /async function prune\(/.test(src),
    "a version is immutable, so its link set only changes when the rules do",
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nAgainst the real tables");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("table checks", "no database connection — the checks above are complete without it");
}

if (connected) {
  try {
    const exists = await owner.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name = 'link_checks'`,
    );

    if (exists.rows[0].n === "0") {
      skip("table checks", "link_checks does not exist — apply migrations/0037");
    } else {
      const policies = await owner.query<{ cmd: string; qual: string | null }>(
        `select cmd, qual from pg_policies where tablename = 'link_checks'`,
      );
      check("link_checks carries a policy", policies.rowCount === 1);
      /*
       * A URL is exactly the kind of value that leaks a customer's internal hostnames, so the
       * public escape hatch has to be a deliberate `org_id is null` rather than an open read.
       */
      check(
        "and it admits the public corpus without admitting other tenants",
        /org_id is null/i.test(policies.rows[0]?.qual ?? "") &&
          /current_setting/i.test(policies.rows[0]?.qual ?? ""),
        policies.rows[0]?.qual?.slice(0, 70),
      );

      const indexes = await owner.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where tablename = 'link_checks'`,
      );
      check(
        "one row per link per document, so the upsert has a target",
        indexes.rows.some(
          (r) => /UNIQUE/.test(r.indexdef) && /skill_version_id/.test(r.indexdef) && /url/.test(r.indexdef),
        ),
      );

      const { linkCheckSummary, rottenLinks } = await import("../src/server/skills/links");
      const summary = await linkCheckSummary();
      check(
        "the summary carries coverage, not just counts",
        typeof summary.versionsChecked === "number" && typeof summary.servable === "number",
        `${summary.versionsChecked} of ${summary.servable} checked`,
      );
      check("and the rotten list reads back", Array.isArray(await rottenLinks(5)));

      /**
       * The reachability fix, driven rather than read.
       *
       * A row backdated past the re-check window must pull its document to the front of the queue.
       * Asserting the SQL exists proves it was written; this proves it works — and the bug it
       * fixes (a threshold no amount of running could ever reach) was invisible to the first kind
       * of check, which is why `nextTargets` is exported at all.
       */
      const { nextTargets } = await import("../src/server/skills/links");
      const [victim] = (
        await owner.query<{ version_id: string; skill_id: string }>(
          `select s.current_version_id as version_id, s.id as skill_id
             from skills s
             join skill_versions sv on sv.id = s.current_version_id
            where s.status = 'indexed' and s.org_id is null and sv.content_stored = true
            limit 1`,
        )
      ).rows;

      if (!victim) {
        skip("the queue-jump probe", "no readable public document to backdate");
      } else {
        await owner.query(
          `insert into link_checks
             (skill_id, skill_version_id, url, status, status_code, consecutive_failures, checked_at)
           values ($1, $2, 'https://verify-freshness.invalid/probe', 'broken', 404, 1,
                   now() - interval '48 hours')
           on conflict (skill_version_id, url) do update
             set consecutive_failures = 1, checked_at = now() - interval '48 hours'`,
          [victim.skill_id, victim.version_id],
        );

        const first = await nextTargets(1);
        check(
          "a document with an unconfirmed failure jumps to the front of the queue",
          first[0]?.versionId === victim.version_id,
          "without this the rot threshold is unreachable at corpus scale",
        );

        /* A confirmed rot needs no more evidence, so it must stop holding the front. */
        await owner.query(
          `update link_checks set consecutive_failures = 5
            where skill_version_id = $1 and url = 'https://verify-freshness.invalid/probe'`,
          [victim.version_id],
        );
        check(
          "and stops jumping once the failure is confirmed",
          (await nextTargets(1))[0]?.versionId !== victim.version_id,
          "re-asking a settled question starves discovery",
        );

        await owner.query(
          `delete from link_checks where url = 'https://verify-freshness.invalid/probe'`,
        );
      }

      /*
       * The panel must show coverage beside the counts. Without it "4 dead links" over a corpus
       * 3% checked reads as a healthy corpus.
       */
      const panel = readFileSync("src/components/settings/freshness-panel.tsx", "utf8");
      check(
        "the panel states coverage beside the dead-link count",
        /servable.*checked|checkedPercent/.test(panel),
      );
      check(
        "and says what it is withholding, and why",
        /blocked/.test(panel) && /unreachable/.test(panel),
        "a reader must know the list is the confident subset",
      );
    }
  } finally {
    await owner.end().catch(() => undefined);
  }
}

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
