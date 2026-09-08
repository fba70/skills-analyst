import "dotenv/config";

import { Client } from "pg";

/**
 * Is the database in the shape the code expects? (Doc 2 R7.2.)
 *
 *   pnpm db:audit
 *
 * Free, read-only, writes nothing.
 *
 * ## Why this exists alongside the `verify:*` suites
 *
 * Each `verify:*` script proves one subsystem's invariants and skips cleanly when its table
 * is absent — which is right for them and leaves a gap nothing covered: **whether every
 * migration actually landed.** A half-applied migration set is a state where most suites go
 * green by skipping, and the one question an operator asks after running `db:migrate` is the
 * one nothing answered.
 *
 * So this compares three things that should agree and cannot drift apart quietly: the
 * migration journal on disk, the applied-migrations table in the database, and the tables,
 * enums and policies the schema declares. It names what is missing rather than reporting a
 * count, because "18 of 19 tables" is not an actionable sentence.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Every table the schema declares. Listed, so a missing one is named rather than counted. */
const TABLES = [
  "user", "session", "account", "verification", "organization", "member", "invitation",
  "sources", "skills", "skill_versions", "skill_signals",
  "verdicts", "capability_surfaces",
  "crawl_shards", "discovered_repos",
  "skill_signatures", "skill_signature_bands", "skill_duplicates", "skill_embeddings",
  "skill_structures", "skill_blocks",
  "skill_categories",
  "archetypes",
  "takedowns", "skill_flags",
  "skill_drafts",
  "builder_signals", "outcome_signals",
  "llm_usage",
  "platform_settings", "rate_limit_buckets", "org_entitlements",
  "pipeline_heartbeat",
  "events",
  "mcp_tokens",
];

/** Enums whose values drive a decision somewhere, with the values that must be present. */
const ENUMS: Record<string, string[]> = {
  skill_status: ["pending", "indexed", "quarantined", "tombstoned", "withdrawn"],
  skill_version_status: ["pending", "validating", "indexed", "quarantined", "revalidating", "tombstoned", "withdrawn"],
  lifecycle_declaration: ["deprecated", "superseded"],
  org_plan: ["free", "pro", "team"],
  flag_reason: ["malicious", "prompt-injection", "secret", "misleading", "broken", "licence", "duplicate", "other"],
  flag_status: ["received", "upheld", "rejected"],
  llm_purpose: ["builder", "validation", "corpus_taxonomy", "corpus_validation", "corpus_embedding"],
};

/** Columns added by the recent plan steps, which a skipped migration would leave absent. */
const COLUMNS: Array<[string, string]> = [
  ["skill_structures", "marker_path"],
  ["skill_structures", "block_types"],
  ["skill_structures", "block_counts"],
  ["skill_structures", "block_count"],
  ["skill_structures", "token_estimate"],
  ["skills", "lifecycle_declaration"],
  ["skills", "superseded_by_skill_id"],
  ["skills", "lifecycle_note"],
  ["skills", "review_by"],
  ["skills", "owner_id"],
  ["skills", "lifecycle_changed_at"],
  ["skill_blocks", "start_char"],
  ["skill_blocks", "end_char"],
  ["skill_embeddings", "embedding"],
  ["org_entitlements", "plan"],
  ["outcome_signals", "kind"],
  ["outcome_signals", "caller_digest"],
  ["outcome_signals", "archetype_category"],
  ["skill_flags", "reason"],
  ["skill_flags", "reporter_digest"],
  ["skill_flags", "decision"],
];

/** Extensions the schema depends on. Neither is expressible in Drizzle. */
const EXTENSIONS = ["pg_trgm", "vector"];

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await c.connect();

console.info("\nMigrations");

const { rows: journalRows } = await c.query<{ n: string; latest: string }>(
  `select count(*)::text as n, max(created_at)::text as latest from drizzle.__drizzle_migrations`,
);
const applied = Number(journalRows[0]?.n ?? 0);

const { readFile } = await import("node:fs/promises");
const journal = JSON.parse(
  await readFile("migrations/meta/_journal.json", "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

check(
  "every migration on disk has been applied",
  applied === journal.entries.length,
  `${applied} applied, ${journal.entries.length} on disk` +
    (applied === journal.entries.length ? "" : ` — run pnpm db:migrate`),
);
console.info(`  note  newest on disk: ${journal.entries.at(-1)?.tag}`);

console.info("\nExtensions");
const { rows: exts } = await c.query<{ name: string; installed_version: string | null }>(
  `select name, installed_version from pg_available_extensions where name = any($1::text[])`,
  [EXTENSIONS],
);
for (const name of EXTENSIONS) {
  const row = exts.find((e) => e.name === name);
  check(`${name} is installed`, Boolean(row?.installed_version), row?.installed_version ?? "absent");
}

console.info("\nTables");
const { rows: present } = await c.query<{ tablename: string }>(
  `select tablename from pg_tables where schemaname = 'public'`,
);
const have = new Set(present.map((r) => r.tablename));
const missingTables = TABLES.filter((t) => !have.has(t));
check("every declared table exists", missingTables.length === 0, missingTables.join(", ") || `${TABLES.length} checked`);

const unexpected = [...have].filter((t) => !TABLES.includes(t));
if (unexpected.length > 0) {
  console.info(`  note  tables not in this list: ${unexpected.join(", ")}`);
}

console.info("\nColumns added by recent plan steps");
const { rows: cols } = await c.query<{ table_name: string; column_name: string }>(
  `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
);
const haveCol = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
const missingCols = COLUMNS.filter(([t, col]) => !haveCol.has(`${t}.${col}`));
check(
  "every recently added column exists",
  missingCols.length === 0,
  missingCols.map(([t, col]) => `${t}.${col}`).join(", ") || `${COLUMNS.length} checked`,
);

console.info("\nEnums");
const { rows: enumRows } = await c.query<{ typname: string; enumlabel: string }>(
  `select t.typname, e.enumlabel from pg_type t join pg_enum e on e.enumtypid = t.oid`,
);
for (const [name, expected] of Object.entries(ENUMS)) {
  const values = enumRows.filter((r) => r.typname === name).map((r) => r.enumlabel);
  const missing = expected.filter((v) => !values.includes(v));
  check(`${name} has its values`, missing.length === 0, missing.join(", ") || `${values.length} values`);
}

console.info("\nRow-level security");
/**
 * Every table carrying an `org_id` or `organization_id` must have a policy.
 *
 * Derived from the columns rather than from a list, so a new org-scoped table is caught
 * automatically. RLS defaults to deny, so a missing policy makes a feature look broken
 * rather than leaky — which is why migration 0006 argued for putting the policy in the same
 * migration as the table.
 */
const { rows: scoped } = await c.query<{ table_name: string }>(
  `select distinct table_name from information_schema.columns
   where table_schema = 'public' and column_name in ('org_id', 'organization_id')
     and table_name in (select tablename from pg_tables where schemaname = 'public')`,
);
const { rows: policies } = await c.query<{ tablename: string; cmd: string }>(
  `select tablename, cmd from pg_policies where schemaname = 'public'`,
);
const policied = new Set(policies.map((p) => p.tablename));
/** Better Auth owns these and scopes them in application code, not with RLS. */
const AUTH_OWNED = new Set(["member", "invitation", "session", "organization"]);
const unprotected = scoped
  .map((r) => r.table_name)
  .filter((t) => !policied.has(t) && !AUTH_OWNED.has(t));
check(
  "every org-scoped corpus table has an RLS policy",
  unprotected.length === 0,
  unprotected.join(", ") || `${scoped.length} scoped tables, ${policied.size} policied`,
);

const { rows: rlsOff } = await c.query<{ relname: string }>(
  `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     and c.relname in (select tablename from pg_policies where schemaname = 'public')`,
);
check(
  "no table has a policy while RLS is switched off",
  rlsOff.length === 0,
  rlsOff.map((r) => r.relname).join(", ") || "none",
  // A policy on a table with RLS disabled is the quietest possible failure: the policy
  // reads as protection in `pg_policies` and enforces nothing at all.
);

console.info("\nCorpus");
const counts = await c.query<{ label: string; n: string }>(`
  select 'skills indexed' as label, count(*)::text as n from skills where status = 'indexed'
  union all select 'skills canonical', count(*)::text from skills where status = 'indexed' and canonical_skill_id is null
  union all select 'skills quarantined', count(*)::text from skills where status = 'quarantined'
  union all select 'sources synced', count(*)::text from sources where last_success_at is not null
  union all select 'sources total', count(*)::text from sources
  union all select 'discovery candidates', count(*)::text from discovered_repos where status = 'new'
  union all select 'verdicts', count(*)::text from verdicts
  union all select 'categories assigned', count(*)::text from skill_categories
  union all select 'archetypes (all versions)', count(*)::text from archetypes
  union all select 'flags open', count(*)::text from skill_flags where status = 'received'
  union all select 'flags decided', count(*)::text from skill_flags where status <> 'received'
  union all select 'outcome signals', count(*)::text from outcome_signals
  union all select 'outcome signals attributed', count(*)::text from outcome_signals where archetype_category is not null
  union all select 'events', count(*)::text from events
`);
for (const row of counts.rows) {
  console.info(`  ${row.label.padEnd(28)} ${Number(row.n).toLocaleString()}`);
}

/**
 * Derived-data coverage, per pinned version — the number that goes stale silently.
 *
 * Every derived table is selected on a version string, so bumping one makes the corpus read
 * as *zero* until the re-extract catches up. Nothing errors, the pages keep serving stored
 * output, and the only visible symptom is a mining run that quietly finds no evidence.
 * `archetypes --blocks` reporting eleven rows of zeros at 1% coverage was exactly this.
 *
 * ## Coverage counts subjects, not rows — and this took a second pass to get right
 *
 * The first version printed `total − current` as "re-derive outstanding", which is wrong on
 * every append-only table here and wrong in the direction that matters: it reports permanent
 * history as permanent unfinished work. `archetypes` keeps all 105 rows on purpose (R7.2
 * reproducibility and R3.5 drift-diffing both need them), and `skill_structures` keeps its
 * extractor 1.x rows, so both columns would have carried a red arrow that no amount of
 * re-deriving could ever clear. An alarm that cannot be silenced stops being read — the
 * same failure as a status line that is green because a table is empty, wearing the other
 * costume.
 *
 * So the question asked is **how many subjects are covered at the pinned version**, against
 * how many there are to cover. That number can reach its target, and its target is stated.
 */
console.info("\nDerived data, at the version the code currently pins");
const { EXTRACTOR_VERSION } = await import("../src/server/analytics/structure");
const { EMBEDDER_VERSION } = await import("../src/server/analytics/embeddings");
const { MINER_VERSION } = await import("../src/server/analytics/archetype");

/**
 * One row per derived table: subjects covered, the subjects there are, and the unit.
 *
 * The unit differs per table and saying so is the point. A fingerprint covers a skill
 * version; an embedding covers a canonical skill, because a near-duplicate variant is
 * deliberately never embedded; an archetype covers a function category, and only the ones
 * that clear the evidence gate can ever be covered.
 */
const coverage = await c.query<{ label: string; covered: string; universe: string; unit: string }>(
  `select 'fingerprints' as label,
          (select count(distinct skill_version_id) from skill_structures
            where extractor_version = $1)::text as covered,
          (select count(*) from skill_versions
            where status in ('indexed','quarantined'))::text as universe,
          'skill versions' as unit
   union all
   select 'embeddings',
          (select count(*) from skill_embeddings where embedder_version = $2)::text,
          (select count(*) from skills
            where status = 'indexed' and canonical_skill_id is null)::text,
          'canonical skills'
   union all
   select 'archetypes',
          (select count(distinct category) from archetypes
            where miner_version = $3 and org_id is null and axis = 'function')::text,
          (select count(distinct category) from archetypes
            where org_id is null and axis = 'function')::text,
          'function categories'`,
  [EXTRACTOR_VERSION, EMBEDDER_VERSION, MINER_VERSION],
);

for (const row of coverage.rows) {
  const covered = Number(row.covered);
  const universe = Number(row.universe);
  const missing = universe - covered;
  /* Floored, not rounded. 50,965 of 50,966 rounds to 100% and would print "100%" beside
     "1 to re-derive" — a line that argues with itself is worse than one that says 99%. */
  const percent = universe === 0 ? 0 : Math.floor((covered / universe) * 100);
  console.info(
    `  ${row.label.padEnd(14)} ${covered.toLocaleString().padStart(8)} of ${universe.toLocaleString().padEnd(8)} ${row.unit.padEnd(23)} ${String(percent).padStart(3)}%` +
      (missing > 0 ? `  <- ${missing.toLocaleString()} to re-derive` : ""),
  );
}

/**
 * Blocks are volume, not coverage — and getting this wrong printed a false alarm.
 *
 * The first version measured blocks as *distinct versions carrying a block row* against
 * current fingerprints, and reported **95 to re-derive**. There is nothing to re-derive:
 * extractor 2.0.0 writes `block_count` on every fingerprint it produces, so a fingerprint at
 * the current version has been block-scanned by construction — and all 95 of those rows say
 * `block_count = 0` because the documents have nothing to segment. Forty-one are empty and
 * the set averages eleven words.
 *
 * Which makes a coverage column for blocks meaningless: it can only ever restate the
 * fingerprint row. What is worth printing is how many blocks exist and how many documents
 * legitimately hold none, because that second number is the honest measure of whether the
 * segmenter is finding structure or inventing it.
 */
const blocks = await c.query<{ total: string; scanned: string; empty: string }>(
  `select (select count(*) from skill_blocks where extractor_version = $1)::text as total,
          (select count(*) from skill_structures where extractor_version = $1)::text as scanned,
          (select count(*) from skill_structures
            where extractor_version = $1 and block_count = 0)::text as empty`,
  [EXTRACTOR_VERSION],
);
{
  const b = blocks.rows[0];
  const scanned = Number(b.scanned);
  const empty = Number(b.empty);
  console.info(
    `  ${"blocks".padEnd(14)} ${Number(b.total).toLocaleString().padStart(8)} typed spans` +
      ` across ${(scanned - empty).toLocaleString()} of ${scanned.toLocaleString()} scanned documents` +
      ` · ${empty.toLocaleString()} hold none`,
  );
}

/**
 * History, reported as history.
 *
 * Rows at a superseded version are not a backlog. They are what makes a stored verdict
 * reproducible and an archetype diffable, and the only honest thing to do with the count is
 * print it under a heading that says so.
 */
const kept = await c.query<{ label: string; n: string }>(
  `select 'fingerprints' as label, count(*)::text as n from skill_structures where extractor_version <> $1
   union all select 'embeddings', count(*)::text from skill_embeddings where embedder_version <> $2
   union all select 'archetypes', count(*)::text from archetypes where miner_version <> $3`,
  [EXTRACTOR_VERSION, EMBEDDER_VERSION, MINER_VERSION],
);
const history = kept.rows.filter((r) => Number(r.n) > 0);
if (history.length > 0) {
  console.info(
    `  retained at a superseded version, deliberately: ` +
      history.map((r) => `${r.label} ${Number(r.n).toLocaleString()}`).join(", "),
  );
}

console.info("\nSpend, cumulative (RC.3 ledger)");
const spend = await c.query<{ purpose: string; calls: string; micros: string }>(
  `select purpose, count(*)::text as calls, coalesce(sum(cost_micros),0)::text as micros
   from llm_usage group by purpose order by sum(cost_micros) desc`,
);
let totalMicros = 0;
for (const row of spend.rows) {
  totalMicros += Number(row.micros);
  console.info(
    `  ${row.purpose.padEnd(20)} ${Number(row.calls).toLocaleString().padStart(8)} calls` +
      `  $${(Number(row.micros) / 1_000_000).toFixed(2)}`,
  );
}
console.info(`  ${"total".padEnd(20)} ${" ".repeat(14)}  $${(totalMicros / 1_000_000).toFixed(2)}`);

await c.end();
console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
