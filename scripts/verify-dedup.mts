import "dotenv/config";

import { Client } from "pg";

/**
 * Repository identity is case-folded, and one repository holds one row (migration 0021).
 *
 *   pnpm verify:dedup
 *
 * Free. No model, no GitHub, no writes that survive — the two insert probes run inside a
 * transaction that is always rolled back.
 *
 * ## Written the way round that makes it evidence
 *
 * The bug was that `github.com/NVIDIA/skills` and `github.com/nvidia/skills` were two
 * `sources` rows for one repository — 268 indexed skills on one and 99 on the other, the
 * same repo fetched twice. Fifteen repositories reached that state and nothing errored,
 * because a case-sensitive unique index is exactly what permitted it.
 *
 * So this script does not assert that the *data* is currently clean and stop there — clean
 * data proves nothing about whether it can get dirty again. It **attempts the insert that
 * caused the bug** and requires Postgres to refuse it with a unique violation. That is the
 * lesson `verify:http-deadline` and `verify:db-retry` were rewritten to follow: a check
 * that cannot observe the failure it is about is not evidence.
 *
 * Runs on `DATABASE_URL_UNPOOLED` because it inspects indexes and needs the owner
 * connection, the same one migrations use.
 */

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Runs `fn` inside a transaction that is always rolled back. */
async function probe(fn: () => Promise<void>): Promise<string | null> {
  await c.query("BEGIN");
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  } finally {
    await c.query("ROLLBACK");
  }
}

await c.connect();

console.info("\nIdentity indexes fold case");

const indexes = await c.query<{ indexname: string; indexdef: string }>(
  `select indexname, indexdef from pg_indexes
    where indexname in ('sources_public_url_uq','sources_org_url_uq','discovered_repos_uq')`,
);
const def = (name: string) => indexes.rows.find((r) => r.indexname === name)?.indexdef ?? "";

const generated = (
  await c.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_name = 'discovered_repos'
        and column_name in ('owner_folded','repo_folded')
        and is_generated = 'ALWAYS'`,
  )
).rows;

check("sources_public_url_uq is on lower(url)", def("sources_public_url_uq").includes("lower(url)"));
check("sources_public_url_uq still keys on kind", def("sources_public_url_uq").includes("kind"));
check(
  "sources_public_url_uq is still public-only",
  def("sources_public_url_uq").toLowerCase().includes("org_id is null"),
);
check("sources_org_url_uq is on lower(url)", def("sources_org_url_uq").includes("lower(url)"));
/*
 * On the generated columns, not on lower(...) expressions — and that distinction is the
 * whole reason migration 0022 exists. An expression index enforces uniqueness correctly and
 * cannot be named by `onConflictDoUpdate`, so 0021 broke every discovery write with 42P10
 * while this script stayed green. Asserting the *shape* here is not pedantry: it is the
 * property the ON CONFLICT probes below depend on.
 */
check(
  "discovered_repos_uq is on the folded columns",
  def("discovered_repos_uq").includes("owner_folded") &&
    def("discovered_repos_uq").includes("repo_folded"),
  def("discovered_repos_uq").replace(/^.*USING btree /, "") || "missing",
);
check(
  "owner_folded/repo_folded are generated, so they cannot drift",
  generated.length === 2,
  generated.map((g) => g.column_name).join(", ") || "none",
);

console.info("\nThe insert that caused the bug is refused");

/**
 * Probed through the **application's** statement shape, not a raw INSERT.
 *
 * The first version of this script probed `insert into ... values (...)` with no ON
 * CONFLICT, and passed for the whole time every discovery write in the codebase was
 * throwing 42P10 — migration 0021 had made `discovered_repos_uq` an expression index, which
 * `onConflictDoUpdate` cannot name. Fifteen green checks over a broken ingest path.
 *
 * The case-flip was also a no-op for a whole class of rows: `ch === ch.toUpperCase() ?
 * toLowerCase : toUpperCase` returns the original for any uncased character, and `.replace`
 * on a non-matching pattern returns the string unchanged — so for a digit-leading owner the
 * "case-variant" insert was byte-identical to the same-kind probe forty lines below, and
 * dropping `lower()` from the index would have turned neither red. Both are now built from
 * a literal that is unambiguously a case variant of a row known to exist.
 */
const [nvidiaish] = (
  await c.query<{ host: string; owner: string; repo: string }>(
    `select host, owner, repo from discovered_repos where owner ~ '[A-Za-z]' order by first_seen_at limit 1`,
  )
).rows;

if (!nvidiaish) {
  check("a candidate exists to probe against", false, "discovered_repos is empty");
} else {
  const flip = (v: string) =>
    v === v.toLowerCase() ? v.toUpperCase() : v.toLowerCase();
  const variantOwner = flip(nvidiaish.owner);
  check(
    "the probe is genuinely a case variant",
    variantOwner !== nvidiaish.owner,
    `${nvidiaish.owner} -> ${variantOwner}`,
  );

  // The exact statement crawl/run.ts, submit.ts and registries.ts issue.
  const upsertProbe = await probe(async () => {
    await c.query(
      `insert into discovered_repos (host, owner, repo, url)
       values ($1, $2, $3, $4)
       on conflict ("host","owner_folded","repo_folded") do update set last_seen_at = now()`,
      [
        nvidiaish.host,
        variantOwner,
        nvidiaish.repo,
        `https://github.com/${variantOwner}/${nvidiaish.repo}`,
      ],
    );
  });
  check(
    "the app's ON CONFLICT target resolves to the folded index",
    upsertProbe === null,
    upsertProbe === "42P10"
      ? "42P10 — the target does not match discovered_repos_uq"
      : (upsertProbe ?? "accepted"),
  );

  const collapsed = await probe(async () => {
    await c.query(
      `insert into discovered_repos (host, owner, repo, url)
       values ($1, $2, $3, $4)
       on conflict ("host","owner_folded","repo_folded") do update set last_seen_at = now()`,
      [nvidiaish.host, variantOwner, nvidiaish.repo, "https://github.com/probe/collapse"],
    );
    const { rows } = await c.query<{ n: number }>(
      `select count(*)::int as n from discovered_repos where host = $1 and owner_folded = lower($2) and repo_folded = lower($3)`,
      [nvidiaish.host, variantOwner, nvidiaish.repo],
    );
    if (rows[0].n !== 1) throw new Error(`${rows[0].n} rows, expected 1`);
  });
  check(
    "a differently-cased upsert updates rather than inserts",
    collapsed === null,
    collapsed ?? "1 row",
  );
}

const [anySource] = (
  await c.query<{ url: string; kind: string }>(
    `select url, kind from sources where org_id is null and url ~ '[A-Za-z]' order by created_at limit 1`,
  )
).rows;

if (!anySource) {
  check("a public source exists to probe against", false, "sources is empty");
} else {
  const variantUrl = anySource.url
    .split("")
    .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
  check("the source probe is a case variant", variantUrl !== anySource.url);

  const sourceProbe = await probe(async () => {
    await c.query(`insert into sources (kind, name, url) values ($1, $2, $3)`, [
      anySource.kind,
      "case-variant probe",
      variantUrl,
    ]);
  });
  check(
    "a case-variant source URL is refused",
    sourceProbe === "23505",
    sourceProbe ?? "it was accepted",
  );
}

console.info("\nAnd the same URL may still be read two ways");

/**
 * `kind` is in the key on purpose. `ComposioHQ/awesome-claude-skills` is on the seed *list*
 * allow-list — read for the repo links inside it — and the crawl separately promoted it as a
 * content repo shipping six skills of its own. Two connectors, two legitimate reads of one
 * URL. Pinned here because folding the case without `kind` would have deleted one of them,
 * and because a later "tidy-up" that drops `kind` from the index would break it silently.
 */
const twoKinds = await c.query<{ n: number }>(
  `select count(*)::int n from (
     select 1 from sources where org_id is null group by lower(url) having count(distinct kind) > 1) t`,
);
const sameKind = await probe(async () => {
  await c.query(`insert into sources (kind, name, url) values ($1, 'same kind probe', $2)`, [
    anySource.kind,
    anySource.url,
  ]);
});
check("a second row of the same kind is still refused", sameKind === "23505", sameKind ?? "it was accepted");
check(
  "a URL read by two connectors keeps both rows",
  Number(twoKinds.rows[0].n) >= 1,
  `${twoKinds.rows[0].n} URL(s) with two kinds`,
);

console.info("\nThe merge left nothing dangling");

const state = (
  await c.query(`select
    (select count(*)::int from (select 1 from sources where org_id is null
       group by lower(url), kind having count(*) > 1) t) dup_sources,
    (select count(*)::int from (select 1 from discovered_repos
       group by host, lower(owner), lower(repo) having count(*) > 1) t) dup_candidates,
    (select count(*)::int from skill_versions v
       left join sources s on s.id = v.source_id where s.id is null) orphan_versions,
    (select count(*)::int from skills sk where sk.current_version_id is not null
       and not exists (select 1 from skill_versions v where v.id = sk.current_version_id)) dangling_current,
    (select count(*)::int from discovered_repos d where d.source_id is not null
       and not exists (select 1 from sources s where s.id = d.source_id)) dangling_candidate_source
  `)
).rows[0] as Record<string, number>;

check("no duplicate public sources remain", state.dup_sources === 0, String(state.dup_sources));
check("no duplicate candidates remain", state.dup_candidates === 0, String(state.dup_candidates));
/*
 * These three are structurally unfailable and are kept as documentation, not as evidence.
 *
 * `skill_versions.source_id` is ON DELETE RESTRICT, so an orphaned version cannot exist —
 * the delete would have been refused. `discovered_repos.source_id` is ON DELETE SET NULL,
 * so a dangling pointer cannot exist either. Counting them as passes inflates the score of
 * this script without testing anything; they are labelled so nobody reads them as coverage.
 */
check("[by constraint] no skill_version points at a deleted source", state.orphan_versions === 0);
check("[by constraint] no candidate points at a deleted source", state.dangling_candidate_source === 0);
// This one can genuinely fail: current_version_id has no foreign key.
check("no skill points at a deleted version", state.dangling_current === 0);

/**
 * One `(source, path)` must resolve to one skill, because that pair is the write path's
 * identity and it is read with `limit(1)`.
 *
 * Scoped to public `github_repo` sources, and that scope is the finding rather than a
 * convenience: each organisation's `builder` source deliberately holds every published
 * draft at `SKILL.md`, so it has as many skills at that one path as it has publications.
 * It is never enumerated — `enabled = false`, no upstream — so the write path never
 * resolves that key against it. An unscoped version of this check reads the builder as a
 * defect, which is how it first came back red.
 */
const collisions = await c.query<{ n: number }>(
  `select count(*)::int n from (
     select v.source_id, v.provenance->>'path' p
     from skill_versions v
     join sources s on s.id = v.source_id
     where s.org_id is null and s.kind = 'github_repo'
     group by 1, 2
     having count(distinct v.skill_id) > 1) t`,
);
check(
  "one (source, path) resolves to one skill",
  Number(collisions.rows[0].n) === 0,
  `${collisions.rows[0].n} colliding pair(s)`,
);

console.info(`\n${pass} passed, ${fail} failed\n`);
await c.end();
process.exit(fail > 0 ? 1 : 0);
