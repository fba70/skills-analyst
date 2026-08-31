import "dotenv/config";

import { eq } from "drizzle-orm";

import { db } from "../src/server/db";
import { organization, user } from "../src/server/db/schema/auth";
import { builderSignals } from "../src/server/db/schema/telemetry";
import { skillVersions } from "../src/server/db/schema/corpus";
import { verdicts } from "../src/server/db/schema/validation";
import { llmUsage } from "../src/server/db/schema/spend";
import { withExplicitOrgScope } from "../src/server/dal/scope";
import { buildScaffold } from "../src/server/builder/scaffold";
import { createForTest, generateForTest, getDraft } from "../src/server/builder/drafts";
import { publishForTest } from "../src/server/builder/publish";
import { formatMicros } from "../src/lib/llm-pricing";

/**
 * Walks one real skill through the whole loop (Doc 2 §7.6).
 *
 *   pnpm walk:loop          # COSTS MONEY — one builder generation
 *
 * Not a test. Every other script in `scripts/verify-*` proves a property against fixtures;
 * this one takes a skill the whole way and **leaves it behind**, because the point is to
 * have the loop actually run once rather than to assert that it could.
 *
 * The chain, in the order the product claims it happens:
 *
 *   scaffold from a mined archetype
 *     → generate (one real model call, charged to the workspace budget)
 *     → validate the draft in memory
 *     → publish through the same pipeline an external skill goes through
 *     → validate again, on stored bytes, writing real verdicts
 *     → record creation telemetry
 *
 * Everything it prints is read back from the database afterwards. A step that claimed
 * success without a row to show for it would be the failure this exists to catch.
 */

const CATEGORY = "review";

function step(n: number, title: string) {
  console.info(`\n${"─".repeat(64)}\n${n}. ${title}\n`);
}

const [org] = await db.select({ id: organization.id, name: organization.name }).from(organization).limit(1);
const [actor] = await db.select({ id: user.id, email: user.email }).from(user).limit(1);
if (!org || !actor) {
  console.error("No workspace or user yet — sign in once, then re-run.");
  process.exit(1);
}
console.info(`workspace: ${org.name}   author: ${actor.email}`);

// --- 1. The scaffold -----------------------------------------------------------
step(1, "Scaffold from the mined archetype");
const scaffold = await buildScaffold(CATEGORY);
if (!scaffold) {
  console.error(`no scaffold for "${CATEGORY}"`);
  process.exit(1);
}
console.info(
  `  ${scaffold.categoryLabel} · archetype v${scaffold.archetypeVersion} · ` +
    `${scaffold.evidence?.structures} structures from ${scaffold.evidence?.sources} sources`,
);
for (const section of scaffold.sections) {
  const evidence =
    section.lift === null
      ? "standard"
      : `${section.strongPrevalence}% vs ${section.weakPrevalence}% (+${section.lift})`;
  console.info(`    ${section.label.padEnd(22)} ${evidence}`);
}

// --- 2. The author's inputs ----------------------------------------------------
step(2, "What the author fills in");
const sectionInputs: Record<string, string> = {
  "when-to-use":
    "Triggered when someone asks to review a Terraform plan before applying it, or " +
    "mentions checking infrastructure changes for risk.",
  troubleshooting:
    "What to do when the plan output is truncated, or when a module's source is a " +
    "private registry the reviewer cannot read.",
};
const draftId = await createForTest(
  {
    name: "Terraform plan review",
    purpose:
      "Reviews a Terraform plan for destructive or high-risk changes before it is applied — " +
      "resource replacement, data loss, IAM widening, and public exposure. Use when someone " +
      "asks to review infrastructure changes or check a plan before applying it.",
    context:
      "We run Terraform 1.9 against AWS. Never suggest applying anything. Report findings as " +
      "a markdown table with severity, resource address and what would happen.",
    category: CATEGORY,
    domain: "devops-infrastructure",
    dialect: "anthropic_skill",
    sectionInputs,
    scaffoldSections: scaffold.sections.map((section) => section.role),
  },
  org.id,
  actor.id,
);
console.info(`  draft ${draftId.slice(0, 8)} created · notes on ${Object.keys(sectionInputs).length} sections`);

// --- 3. Generation -------------------------------------------------------------
step(3, "Generate (one model call, charged to the workspace budget)");
const generated = await generateForTest(draftId, org.id);
if (!generated.ok) {
  console.error(`  generation failed: ${generated.message}`);
  process.exit(1);
}
if (generated.refused) {
  console.error(`  refused: ${generated.reason}`);
  process.exit(1);
}

const draft = await getDraft(draftId, org.id);
console.info(
  `  ${draft?.body?.length} chars · quality ${draft?.qualityScore}/100 · ` +
    `${draft?.validation?.findings.length ?? 0} finding(s) · model ${draft?.model}`,
);
console.info(`\n  ── first 400 characters ──\n`);
console.info(
  (draft?.body ?? "")
    .slice(0, 400)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n"),
);

// --- 4. Publish ----------------------------------------------------------------
step(4, "Publish through the same pipeline an external skill goes through");
const published = await publishForTest(draftId, org.id, actor.id);
if (!published.ok) {
  console.error(`  publish failed: ${published.message}`);
  process.exit(1);
}
console.info(
  `  /skills/${published.slug} · status ${published.status} · quality ${published.qualityScore}/100` +
    (published.reasons.length > 0 ? ` · ${published.reasons.join(", ")}` : ""),
);

// --- 5. What is actually in the database ---------------------------------------
step(5, "Read it all back");

const rows = await withExplicitOrgScope(org.id, async (tx) => {
  const [version] = await tx
    .select({
      id: skillVersions.id,
      status: skillVersions.status,
      licenseSource: skillVersions.licenseSource,
      provenance: skillVersions.provenance,
    })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, published.skillId));

  const verdictRows = await tx
    .select({ analyzer: verdicts.analyzer, result: verdicts.result, version: verdicts.analyzerVersion })
    .from(verdicts)
    .where(eq(verdicts.skillVersionId, version.id));

  const signals = await tx
    .select({
      role: builderSignals.sectionRole,
      authored: builderSignals.authored,
      survived: builderSignals.survived,
      firstPass: builderSignals.firstPassValid,
    })
    .from(builderSignals)
    .where(eq(builderSignals.draftId, draftId));

  const spend = await tx
    .select({ cost: llmUsage.costMicros, model: llmUsage.model, purpose: llmUsage.purpose })
    .from(llmUsage)
    .where(eq(llmUsage.orgId, org.id));

  return { version, verdictRows, signals, spend };
});

const provenance = rows.version.provenance as Record<string, unknown>;
console.info(`  version    ${rows.version.status} · licence source "${rows.version.licenseSource}"`);
console.info(
  `  lineage    archetype ${provenance.archetypeCategory} v${provenance.archetypeVersion} · ` +
    `authored here: ${provenance.authoredHere}`,
);
console.info(`  verdicts   ${rows.verdictRows.map((v) => `${v.analyzer}@${v.version}=${v.result}`).join(", ")}`);
console.info(`  telemetry  ${rows.signals.length} signal(s):`);
for (const signal of rows.signals) {
  console.info(
    `               ${signal.role.padEnd(18)} authored=${String(signal.authored).padEnd(5)} ` +
      `survived=${String(signal.survived).padEnd(5)} firstPass=${signal.firstPass}`,
  );
}
const total = rows.spend.reduce((sum, row) => sum + Number(row.cost), 0);
console.info(`  spend      ${formatMicros(total)} across ${rows.spend.length} call(s)`);

console.info(
  `\n${"─".repeat(64)}\nThe loop ran. Draft /build/${draftId} · skill /skills/${published.slug}\n`,
);
process.exit(0);
