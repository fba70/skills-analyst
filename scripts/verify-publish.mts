import "dotenv/config";

import { eq, like } from "drizzle-orm";

import { db } from "../src/server/db";
import { skillDrafts } from "../src/server/db/schema/drafts";
import { skills, skillVersions, sources } from "../src/server/db/schema/corpus";
import { verdicts } from "../src/server/db/schema/validation";
import { builderSignals } from "../src/server/db/schema/telemetry";
import { organization } from "../src/server/db/schema/auth";
import { user } from "../src/server/db/schema/auth";
import { buildDraftArchive } from "../src/server/builder/export";
import { renderDialect } from "../src/server/builder/dialects";
import { publishForTest } from "../src/server/builder/publish";
import { deleteBundle } from "../src/server/storage";
import { withExplicitOrgScope } from "../src/server/dal/scope";

/**
 * Proves publish-back and export (Doc 2 R6.1, R4.4, R4.5).
 *
 *   pnpm verify:publish
 *
 * Free — no model call. The dialect and archive checks are pure; the publish half writes to
 * the database and to R2 and cleans up after itself.
 *
 * The property that matters is **R6.1's "no privileged path"**. It is easy to satisfy in
 * prose and easy to lose in code: the tempting shortcut is to mark an authored skill
 * `indexed` because we just validated the draft in memory. So the checks below do not ask
 * "did publishing succeed" — they ask whether the row went through the *real* validator:
 * whether `verdicts` exist, written by the same analyzers at the same versions that judge
 * an externally synced skill.
 */

let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

const prefix = `pubfix-${Date.now()}`;
const BODY = `## Purpose\n\nChecks a thing.\n\n## When to use it\n\nWhen asked to check the thing.\n\n## Steps\n\n1. Read the input.\n2. Report findings as a table.\n`;
const DESCRIPTION = 'Checks a thing. Use when asked to review it: carefully, with a table.';

// --- Dialects render to the right envelope -----------------------------------
{
  const source = { name: "Check A Thing", slug: prefix, description: DESCRIPTION, body: BODY };

  const skill = renderDialect(source, "anthropic_skill");
  check(
    "SKILL.md carries name and description frontmatter",
    skill.path === "SKILL.md" &&
      /^---\nname: /.test(skill.content.toString("utf8")) &&
      skill.content.toString("utf8").includes("description:"),
    skill.content.toString("utf8").slice(0, 80),
  );

  const agents = renderDialect(source, "agents_md");
  const agentsText = agents.content.toString("utf8");
  check(
    "AGENTS.md has no frontmatter and leads with a heading",
    agents.path === "AGENTS.md" && !agentsText.startsWith("---") && agentsText.startsWith("# "),
    agentsText.slice(0, 60),
  );

  const cursor = renderDialect(source, "cursor_rule");
  const cursorText = cursor.content.toString("utf8");
  check(
    "the Cursor rule uses Cursor's own keys, not ours",
    cursor.path === `${prefix}.mdc` &&
      cursorText.includes("alwaysApply:") &&
      cursorText.includes("globs:") &&
      !cursorText.includes("\nname:"),
    cursorText.slice(0, 100),
  );

  /**
   * The colon in the fixture description is the point.
   *
   * Ten skills in the corpus were quarantined because an unquoted colon made YAML read a
   * nested mapping. A builder that emitted descriptions unquoted would manufacture the
   * defect its own validator flags.
   */
  check(
    "descriptions are quoted so a colon cannot break the YAML",
    skill.content.toString("utf8").includes(`description: ${JSON.stringify(DESCRIPTION)}`),
    "the description was emitted unquoted",
  );
}

// --- The archive: one directory per format, plus a receipt (R4.4) ------------
{
  const draft = {
    name: "Check A Thing",
    slug: prefix,
    summary: DESCRIPTION,
    body: BODY,
    frontmatter: { name: prefix, description: DESCRIPTION },
    archetypeCategory: "review",
    archetypeVersion: 5,
    domainCategory: "software-engineering",
    model: "anthropic/claude-sonnet-5",
    validation: { qualityScore: 88, blocked: false, findings: [] },
    qualityScore: 88,
  };

  const first = buildDraftArchive(draft, ["anthropic_skill", "agents_md", "cursor_rule"]);
  const { unzipSync } = await import("fflate");
  const names = Object.keys(unzipSync(first.bytes));

  check(
    "one directory per requested format",
    names.includes(`${prefix}/anthropic_skill/SKILL.md`) &&
      names.includes(`${prefix}/agents_md/AGENTS.md`) &&
      names.includes(`${prefix}/cursor_rule/${prefix}.mdc`),
    names.join(", "),
  );

  const receipt = JSON.parse(
    new TextDecoder().decode(unzipSync(first.bytes)[`${prefix}/SKILL-FOUNDRY.json`]),
  );
  check(
    "the receipt embeds archetype version and the validation report hash",
    receipt.archetype?.version === 5 &&
      receipt.archetype?.category === "review" &&
      typeof receipt.validation?.validationReportHash === "string",
    JSON.stringify(receipt.archetype ?? {}),
  );

  // Same property the corpus export guarantees, for the same reason: a consumer can hash
  // what they received and compare it with what someone else received.
  const second = buildDraftArchive(draft, ["anthropic_skill", "agents_md", "cursor_rule"]);
  check(
    "two exports of an unchanged draft are byte-identical",
    Buffer.from(first.bytes).equals(Buffer.from(second.bytes)),
    `${first.contentHash} vs ${second.contentHash}`,
  );
}

// --- Publish-back goes through the real validator (R6.1) ---------------------
const [org] = await db.select({ id: organization.id }).from(organization).limit(1);
const [actor] = await db.select({ id: user.id }).from(user).limit(1);

if (!org || !actor) {
  console.info("\n  No organisation or user yet — sign in once, then re-run.\n");
  process.exit(failures > 0 ? 1 : 0);
}

let publishedSkillId: string | null = null;
let contentHash: string | null = null;

{
  // RLS refused an unscoped insert here, correctly: `skill_drafts` has no `IS NULL` case.
  const [draft] = await withExplicitOrgScope(org.id, (tx) => tx
    .insert(skillDrafts)
    .values({
      orgId: org.id,
      createdBy: actor.id,
      name: "Check A Thing",
      slug: prefix,
      summary: DESCRIPTION,
      dialect: "anthropic_skill",
      archetypeCategory: "review",
      archetypeVersion: 5,
      purpose: "Checks a thing when asked to review it.",
      sectionInputs: { "when-to-use": "when asked" },
      // What the scaffold offered, so publish can record which of them survived (R6.2).
      scaffoldSections: ["purpose", "when-to-use", "troubleshooting"],
      status: "ready",
      body: BODY,
      frontmatter: { name: prefix, description: DESCRIPTION },
      model: "anthropic/claude-sonnet-5",
      validation: { qualityScore: 88, blocked: false, findings: [] },
      qualityScore: 88,
    })
    .returning({ id: skillDrafts.id }));

  const result = await publishForTest(draft.id, org.id, actor.id);
  check("a ready draft publishes", result.ok, result.ok ? "" : result.message);

  if (result.ok) {
    publishedSkillId = result.skillId;

    const [version] = await withExplicitOrgScope(org.id, (tx) => tx
      .select({
        id: skillVersions.id,
        status: skillVersions.status,
        contentHash: skillVersions.contentHash,
        contentStored: skillVersions.contentStored,
        licenseSource: skillVersions.licenseSource,
        provenance: skillVersions.provenance,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, result.skillId)));
    contentHash = version.contentHash;

    /**
     * The check R6.1 is actually about.
     *
     * Not "is the status indexed" — that could be set by anything. Verdict rows can only
     * exist if `validatePending` ran, and it is the same function the pipeline runs over
     * externally synced versions.
     */
    const rows = await withExplicitOrgScope(org.id, (tx) => tx
      .select({ analyzer: verdicts.analyzer, version: verdicts.analyzerVersion })
      .from(verdicts)
      .where(eq(verdicts.skillVersionId, version.id)));
    check(
      "the real validator ran — verdicts exist, from the same analyzers",
      rows.length >= 4,
      `${rows.length} verdict(s): ${rows.map((r) => `${r.analyzer}@${r.version}`).join(", ")}`,
    );

    check(
      "it landed in a real status, decided by validation",
      version.status === "indexed" || version.status === "quarantined",
      `status=${version.status}`,
    );

    const provenance = version.provenance as Record<string, unknown>;
    check(
      "archetype lineage is recorded on the version",
      provenance.authoredHere === true &&
        provenance.archetypeCategory === "review" &&
        provenance.archetypeVersion === 5 &&
        provenance.draftId === draft.id,
      JSON.stringify(provenance).slice(0, 160),
    );

    check(
      "the licence is `authored`, not `unresolved`",
      version.licenseSource === "authored" && version.contentStored === true,
      `licenseSource=${version.licenseSource}, stored=${version.contentStored}`,
    );

    const [after] = await withExplicitOrgScope(org.id, (tx) => tx
      .select({ publishedSkillId: skillDrafts.publishedSkillId })
      .from(skillDrafts)
      .where(eq(skillDrafts.id, draft.id)));
    check(
      "the draft points at what it became",
      after.publishedSkillId === result.skillId,
      `${after.publishedSkillId}`,
    );

    /**
     * Creation telemetry is written by the publish path (R6.2).
     *
     * Checked here rather than in `verify:telemetry` because that script tests the bounds
     * on fixtures it writes itself — this is the only place that proves the *producer* runs
     * at all, and a loop whose signals are never recorded is a loop that does not close.
     */
    const signals = await db
      .select({
        role: builderSignals.sectionRole,
        survived: builderSignals.survived,
        authored: builderSignals.authored,
        firstPass: builderSignals.firstPassValid,
      })
      .from(builderSignals)
      .where(eq(builderSignals.draftId, draft.id));

    check(
      "publishing records one signal per offered section",
      signals.length === 3,
      `${signals.length} signal(s): ${signals.map((x) => x.role).join(", ")}`,
    );
    check(
      "survival is read from the published body, not assumed",
      signals.find((x) => x.role === "purpose")?.survived === true &&
        signals.find((x) => x.role === "troubleshooting")?.survived === false,
      signals.map((x) => `${x.role}=${x.survived}`).join(" "),
    );
    check(
      "author engagement is recorded separately from survival",
      signals.find((x) => x.role === "when-to-use")?.authored === true &&
        signals.find((x) => x.role === "purpose")?.authored === false,
      signals.map((x) => `${x.role}:authored=${x.authored}`).join(" "),
    );

    const second = await publishForTest(draft.id, org.id, actor.id);
    check(
      "publishing twice is refused",
      !second.ok,
      "a second publish created another skill",
    );

    // The builder source must stay invisible to the scheduler and to public statistics.
    const [src] = await withExplicitOrgScope(org.id, (tx) => tx
      .select({ kind: sources.kind, enabled: sources.enabled, orgId: sources.orgId })
      .from(sources)
      .where(eq(sources.url, `builder://${org.id}`)));
    check(
      "the builder source is org-scoped and never synced",
      src.kind === "builder" && src.enabled === false && src.orgId === org.id,
      `kind=${src?.kind}, enabled=${src?.enabled}`,
    );
  }
}

// Cleanup: the skill cascades its version and verdicts; the bundle and draft go by hand.
if (publishedSkillId)
  await withExplicitOrgScope(org.id, (tx) => tx.delete(skills).where(eq(skills.id, publishedSkillId!)));
await withExplicitOrgScope(org.id, (tx) => tx.delete(skillDrafts).where(like(skillDrafts.slug, `${prefix}%`)));
if (contentHash) await deleteBundle("public", contentHash);

console.info(failures === 0 ? "\nPublish-back and export verified.\n" : `\n${failures} failure(s)\n`);
process.exit(failures > 0 ? 1 : 0);
