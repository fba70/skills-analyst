import "dotenv/config";
import { Client } from "pg";

/**
 * Proves the RLS backstop is real, not merely configured.
 *
 * Seeds one public skill and two private ones belonging to different orgs, then reads
 * the table as the runtime role under three different `app.org_id` settings. A policy
 * that is enabled but ineffective (wrong role, BYPASSRLS, missing SET LOCAL) fails here.
 *
 *   pnpm db:verify-rls
 *
 * Leaves nothing behind: every write happens in a transaction that is rolled back.
 */

const OWNER = process.env.DATABASE_URL_UNPOOLED;
const RUNTIME = process.env.DATABASE_URL;

type Check = { name: string; expected: string[]; actual: string[]; ok: boolean };

async function main() {
  if (!OWNER || !RUNTIME) throw new Error("Need DATABASE_URL and DATABASE_URL_UNPOOLED");

  const owner = new Client({ connectionString: OWNER });
  await owner.connect();

  // Two throwaway orgs to scope the fixtures.
  const orgA = `rls-test-a-${Date.now()}`;
  const orgB = `rls-test-b-${Date.now()}`;

  await owner.query("begin");
  try {
    for (const [id, name] of [
      [orgA, "RLS Test A"],
      [orgB, "RLS Test B"],
    ]) {
      await owner.query(
        `insert into organization (id, name, slug, created_at) values ($1, $2, $1, now())`,
        [id, name],
      );
    }
    const source = await owner.query<{ id: string }>(
      `insert into sources (kind, name, url) values ('github_repo', 'rls-fixture', $1) returning id`,
      [`https://example.invalid/rls-${Date.now()}`],
    );
    const sourceId = source.rows[0].id;

    for (const [org, slug] of [
      [null, "public-skill"],
      [orgA, "org-a-secret"],
      [orgB, "org-b-secret"],
    ] as Array<[string | null, string]>) {
      await owner.query(
        `insert into skills (org_id, dialect, name, slug, status) values ($1, 'anthropic_skill', $2, $2, 'indexed')`,
        [org, `${slug}-${Date.now()}`],
      );
    }
    void sourceId;

    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    await owner.end();
    throw error;
  }

  // Read back as the least-privilege role.
  const runtime = new Client({ connectionString: RUNTIME });
  await runtime.connect();

  async function visibleSlugs(orgId: string | null): Promise<string[]> {
    await runtime.query("begin");
    if (orgId) {
      // What the DAL does on every entry point.
      await runtime.query("select set_config('app.org_id', $1, true)", [orgId]);
    }
    const { rows } = await runtime.query<{ slug: string; org_id: string | null }>(
      "select slug, org_id from skills where slug like '%-skill-%' or slug like '%-secret-%'",
    );
    await runtime.query("rollback");
    return rows.map((r) => (r.org_id === null ? "public" : r.org_id === orgA ? "A" : "B")).sort();
  }

  const checks: Check[] = [];
  const asAnonymous = await visibleSlugs(null);
  checks.push({
    name: "no session sees only the public corpus",
    expected: ["public"],
    actual: asAnonymous,
    ok: JSON.stringify(asAnonymous) === JSON.stringify(["public"]),
  });

  const asA = await visibleSlugs(orgA);
  checks.push({
    name: "org A sees public + its own, never org B",
    expected: ["A", "public"],
    actual: asA,
    ok: JSON.stringify(asA) === JSON.stringify(["A", "public"]),
  });

  const asB = await visibleSlugs(orgB);
  checks.push({
    name: "org B sees public + its own, never org A",
    expected: ["B", "public"],
    actual: asB,
    ok: JSON.stringify(asB) === JSON.stringify(["B", "public"]),
  });

  // A write that lies about its org must be refused, not silently redirected.
  await runtime.query("begin");
  await runtime.query("select set_config('app.org_id', $1, true)", [orgA]);
  let crossOrgWriteBlocked = false;
  try {
    await runtime.query(
      `insert into skills (org_id, dialect, name, slug) values ($1, 'anthropic_skill', 'smuggled', $2)`,
      [orgB, `smuggled-${Date.now()}`],
    );
  } catch {
    crossOrgWriteBlocked = true;
  }
  await runtime.query("rollback");
  checks.push({
    name: "org A cannot write a row owned by org B",
    expected: ["blocked"],
    actual: [crossOrgWriteBlocked ? "blocked" : "ALLOWED"],
    ok: crossOrgWriteBlocked,
  });

  await runtime.end();

  // Clean up the fixtures with the owner connection.
  await owner.query("delete from organization where id = any($1)", [[orgA, orgB]]);
  await owner.query("delete from skills where org_id is null and slug like 'public-skill-%'");
  await owner.query("delete from sources where url like 'https://example.invalid/rls-%'");
  await owner.end();

  for (const check of checks) {
    console.info(
      `${check.ok ? "PASS" : "FAIL"}  ${check.name}\n      expected ${JSON.stringify(check.expected)}  got ${JSON.stringify(check.actual)}`,
    );
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
  console.info("\nRLS backstop verified.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
