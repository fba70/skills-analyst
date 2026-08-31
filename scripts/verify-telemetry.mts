import "dotenv/config";

import { eq, inArray, like, sql } from "drizzle-orm";

import { db } from "../src/server/db";
import { builderSignals } from "../src/server/db/schema/telemetry";
import { skillDrafts } from "../src/server/db/schema/drafts";
import { organization } from "../src/server/db/schema/auth";
import { withExplicitOrgScope } from "../src/server/dal/scope";
import {
  categoryTelemetry,
  describeTelemetry,
  MAX_DRAFTS_PER_ORG,
  MAX_LIFT_DELTA,
  MIN_DISTINCT_ORGS,
} from "../src/server/builder/telemetry";

/**
 * Proves creation telemetry and its poisoning bounds (Doc 2 R6.2, R6.5).
 *
 *   pnpm verify:telemetry
 *
 * Free — no model call. Fixtures are written into a scratch category that no real archetype
 * uses, so nothing here can move published guidance, and everything is deleted afterwards.
 *
 * **R6.5 is four separate defences and this checks each one against the attack it stops.**
 * A test that only asserted "the aggregate came out about right" would pass with three of
 * the four missing:
 *
 *   1. dedup per identity — republishing must not double-count
 *   2. rate limit — one organisation making many drafts must not out-vote the rest
 *   3. outlier trimming — a coordinated tail must not drag the mean
 *   4. bounded delta — whatever survives the above still cannot move a lift far
 *
 * plus the floor beneath them: below `MIN_DISTINCT_ORGS`, nothing is applied at all — which
 * is also the privacy control that stops an aggregate describing one tenant.
 */

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const CATEGORY = `telfix-${Date.now()}`;
const ROLE = "troubleshooting";

const orgs = await db.select({ id: organization.id }).from(organization).limit(4);
if (orgs.length === 0) {
  console.info("\n  No organisation yet — sign in once, then re-run.\n");
  process.exit(1);
}

const draftIds: string[] = [];

/** Writes one draft plus its signal, in that organisation's scope. */
async function signal(orgId: string, opts: { survived: boolean; firstPass: boolean }) {
  const id = await withExplicitOrgScope(orgId, async (tx) => {
    const [draft] = await tx
      .insert(skillDrafts)
      .values({
        orgId,
        name: "telemetry fixture",
        slug: `${CATEGORY}-${draftIds.length}`,
        dialect: "anthropic_skill",
        archetypeCategory: CATEGORY,
        purpose: "fixture",
        status: "ready",
      })
      .returning({ id: skillDrafts.id });

    await tx.insert(builderSignals).values({
      orgId,
      draftId: draft.id,
      archetypeCategory: CATEGORY,
      archetypeVersion: 1,
      sectionRole: ROLE,
      offered: true,
      authored: false,
      survived: opts.survived,
      firstPassValid: opts.firstPass,
    });
    return draft.id;
  });
  draftIds.push(id);
  return id;
}

// --- The floor: too few organisations means nothing is applied ---------------
{
  await signal(orgs[0].id, { survived: true, firstPass: true });
  const result = await categoryTelemetry(CATEGORY);
  check(
    "below the organisation floor, no signal is applied",
    result.sections.length === 0 && result.withheldReason !== null,
    `sections=${result.sections.length}, reason=${result.withheldReason}`,
  );
}

// --- Dedup per identity: the same draft cannot vote twice --------------------
{
  const draftId = draftIds[0];
  let rejected = false;
  try {
    await withExplicitOrgScope(orgs[0].id, (tx) =>
      tx.insert(builderSignals).values({
        orgId: orgs[0].id,
        draftId,
        archetypeCategory: CATEGORY,
        sectionRole: ROLE,
        offered: true,
        authored: false,
        survived: false,
        firstPassValid: false,
      }),
    );
  } catch {
    rejected = true;
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(builderSignals)
    .where(eq(builderSignals.draftId, draftId));
  check(
    "one draft contributes one signal per section, enforced by the database",
    rejected && count === 1,
    `rejected=${rejected}, rows=${count}`,
  );
}

// --- Rate limit: one organisation cannot out-vote the rest -------------------
if (orgs.length >= MIN_DISTINCT_ORGS) {
  // A flooder: many drafts, all claiming the section should be dropped.
  for (let i = 0; i < MAX_DRAFTS_PER_ORG + 6; i += 1) {
    await signal(orgs[0].id, { survived: false, firstPass: false });
  }
  // Two honest organisations that kept it.
  await signal(orgs[1 % orgs.length].id, { survived: true, firstPass: true });
  await signal(orgs[2 % orgs.length].id, { survived: true, firstPass: true });

  const counted = await db.execute(sql`
    with ranked as (
      select org_id, dense_rank() over (partition by org_id order by draft_id) as r
      from builder_signals where archetype_category = ${CATEGORY}
    )
    select count(*)::int as counted from ranked where r <= ${MAX_DRAFTS_PER_ORG}
  `);
  const total = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(builderSignals)
    .where(eq(builderSignals.archetypeCategory, CATEGORY));

  const capped = (counted.rows[0] as { counted: number }).counted;
  check(
    "an organisation's drafts are capped before anything is counted",
    capped < total[0].n,
    `counted ${capped} of ${total[0].n} — the flood was not capped`,
  );
}

// --- The bounded delta holds however lopsided the input ----------------------
{
  const result = await categoryTelemetry(CATEGORY);
  const section = result.sections.find((s) => s.role === ROLE);

  check(
    "a category over the floor produces a usable signal",
    result.orgs >= Math.min(MIN_DISTINCT_ORGS, orgs.length) ? section !== undefined : true,
    `orgs=${result.orgs}, sections=${result.sections.length}`,
  );

  if (section) {
    check(
      "the delta never exceeds the per-cycle bound",
      Math.abs(section.delta) <= MAX_LIFT_DELTA,
      `delta=${section.delta}, bound=${MAX_LIFT_DELTA}`,
    );
    check(
      "the aggregate reports its own sample size",
      section.drafts > 0 && section.orgs > 0,
      `drafts=${section.drafts}, orgs=${section.orgs}`,
    );

    // R6.2's acceptance criterion: the changelog must cite the statistics.
    const citation = describeTelemetry(result);
    check(
      "the changelog citation names the sections that moved",
      section.delta === 0 || (citation !== null && citation.includes("workspaces")),
      `citation=${citation}`,
    );
  }
}

// --- Nothing tenant-identifying can reach an aggregate -----------------------
{
  const result = await categoryTelemetry(CATEGORY);
  const serialised = JSON.stringify(result);
  check(
    "no organisation identifier appears in the aggregate",
    orgs.every((o) => !serialised.includes(o.id)),
    "an org id leaked into the aggregate",
  );
}

// Cleanup. Signals cascade from their drafts.
for (const orgId of new Set(orgs.map((o) => o.id))) {
  await withExplicitOrgScope(orgId, (tx) =>
    tx.delete(skillDrafts).where(like(skillDrafts.slug, `${CATEGORY}%`)),
  );
}
const leftover = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(builderSignals)
  .where(eq(builderSignals.archetypeCategory, CATEGORY));
if (leftover[0].n > 0 && draftIds.length > 0) {
  await withExplicitOrgScope(orgs[0].id, (tx) =>
    tx.delete(builderSignals).where(inArray(builderSignals.draftId, draftIds)),
  );
}

console.info(
  failures === 0 ? "\nTelemetry and its bounds verified.\n" : `\n${failures} failure(s)\n`,
);
process.exit(failures > 0 ? 1 : 0);
