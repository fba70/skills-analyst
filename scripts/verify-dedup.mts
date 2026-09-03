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

check("sources_public_url_uq is on lower(url)", def("sources_public_url_uq").includes("lower(url)"));
check("sources_public_url_uq still keys on kind", def("sources_public_url_uq").includes("kind"));
check(
  "sources_public_url_uq is still public-only",
  def("sources_public_url_uq").toLowerCase().includes("org_id is null"),
);
check("sources_org_url_uq is on lower(url)", def("sources_org_url_uq").includes("lower(url)"));
check(
  "discovered_repos_uq is on lower(owner), lower(repo)",
  def("discovered_repos_uq").includes("lower(owner)") && def("discovered_repos_uq").includes("lower(repo)"),
);

console.info("\nThe insert that caused the bug is refused");

/**
 * Derived from a row that exists rather than hardcoded, so the probe cannot silently start
 * testing a URL nothing collides with. `NvIdIa` is a casing no crawl would produce, which
 * is the point: only case-folding can catch it.
 */
const [anySource] = (
  await c.query<{ url: string; kind: string }>(
    `select url, kind from sources where org_id is null order by created_at limit 1`,
  )
).rows;

const sourceProbe = await probe(async () => {
  await c.query(`insert into sources (kind, name, url) values ($1, $2, $3)`, [
    anySource.kind,
    "case-variant probe",
    anySource.url.replace(/^(https:\/\/github\.com\/)(.)/i, (_m, p, ch) =>
      p + (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()),
    ),
  ]);
});
check("a case-variant source URL is refused", sourceProbe === "23505", sourceProbe ?? "it was accepted");

const [anyRepo] = (
  await c.query<{ host: string; owner: string; repo: string; url: string }>(
    `select host, owner, repo, url from discovered_repos order by first_seen_at limit 1`,
  )
).rows;

const repoProbe = await probe(async () => {
  await c.query(`insert into discovered_repos (host, owner, repo, url) values ($1, $2, $3, $4)`, [
    anyRepo.host,
    anyRepo.owner.toUpperCase() === anyRepo.owner ? anyRepo.owner.toLowerCase() : anyRepo.owner.toUpperCase(),
    anyRepo.repo,
    `${anyRepo.url}#probe`,
  ]);
});
check("a case-variant candidate owner is refused", repoProbe === "23505", repoProbe ?? "it was accepted");

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
check("no skill_version points at a deleted source", state.orphan_versions === 0);
check("no skill points at a deleted version", state.dangling_current === 0);
check("no candidate points at a deleted source", state.dangling_candidate_source === 0);

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
