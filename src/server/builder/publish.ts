import "server-only";

import { and, eq } from "drizzle-orm";

import { events, skillDrafts, skills, skillVersions, sources } from "@/server/db/schema";
/**
 * Explicit scope, not `withOrgScope`.
 *
 * The organisation arrives as an argument — resolved from the session by `publishDraft`,
 * never from anything a client sends — so re-deriving it would be redundant *and* would
 * make this whole path session-bound for no reason. `withExplicitOrgScope` stays
 * `server-only` and is never reachable from a `"use server"` action.
 */
import { withExplicitOrgScope } from "@/server/dal/scope";
import { storeBundle } from "@/server/storage";
import { getAppUrl } from "@/lib/app-url";

import { renderDialect, type DialectId } from "./dialects";
import { getDraft } from "./drafts";

/**
 * Publishing a draft into the corpus (Doc 2 R6.1, R4.5).
 *
 * ## No privileged path, taken literally
 *
 * R6.1 does not say "validate it too". It says a skill created here **enters the same
 * ingestion and validation pipeline as an external skill**, and the honest way to satisfy
 * that is to write the same rows and call the same function — not to reimplement a lighter
 * version and trust it stays equivalent.
 *
 * So publishing does exactly what `syncSource` does for a skill it has just fetched: store
 * the bundle at its content hash, insert a `skill_versions` row with status `pending`, and
 * hand the id to `validatePending`. The verdicts, the quality score, the status transition
 * and the audit events are all produced by the code that judges everything else. If the
 * validator gets stricter tomorrow, authored skills get stricter with it, automatically.
 *
 * The draft's own pre-generation check (`validateBody`) is a *preview*, not this. It runs
 * the free analyzers in memory so an author sees findings before committing; this is the
 * real pass, on stored bytes, writing real verdicts.
 *
 * ## Published into the workspace, not into the public corpus
 *
 * The skill is org-scoped. RC.5 and the RLS policies keep org content out of public
 * archetypes and public statistics, and promoting something to the public corpus is a
 * different decision involving licence and review that nobody has made yet. "Publish" here
 * means "this is a real, validated, downloadable skill in your workspace".
 *
 * ## The source is real, because the schema is right to insist
 *
 * `skill_versions.source_id` is NOT NULL, and rather than work around that, each
 * organisation gets one `builder` source. It is `enabled = false`, so the scheduler never
 * offers it, and org-scoped, so public statistics never count it — both properties fall out
 * of existing behaviour rather than needing special cases.
 */

export type PublishResult =
  | { ok: true; skillId: string; slug: string; status: string; qualityScore: number; reasons: string[] }
  | { ok: false; message: string };

/** One per organisation, created on first publish. */
async function builderSourceId(orgId: string): Promise<string> {
  const url = `builder://${orgId}`;

  return withExplicitOrgScope(orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.url, url), eq(sources.orgId, orgId)))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await tx
      .insert(sources)
      .values({
        orgId,
        kind: "builder",
        name: "Authored in Skills Foundry",
        url,
        // Never synced: there is no upstream to re-read, and a fetch would fail. Disabled
        // is also what keeps it out of `pendingSources`, which selects on `enabled`.
        enabled: false,
        health: "healthy",
      })
      .returning({ id: sources.id });
    return created.id;
  });
}

export async function publishDraft(draftId: string): Promise<PublishResult> {
  const { requireSession } = await import("@/server/dal/session");
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { ok: false, message: "No active workspace." };
  return applyPublish(draftId, orgId, session.user.id);
}

/**
 * Test seam for `verify-publish.mts`, matching `upholdForTest` in the takedown module.
 *
 * Skips `requireSession()` and nothing else — the rows written and the validator called are
 * the same. `requireSession` reaches `next/navigation`, which cannot load in a plain node
 * process, and that is the only reason this exists.
 */
export const publishForTest = (draftId: string, orgId: string, userId: string) =>
  applyPublish(draftId, orgId, userId);

async function applyPublish(
  draftId: string,
  orgId: string,
  userId: string,
): Promise<PublishResult> {

  const draft = await getDraft(draftId, orgId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (!draft.body) return { ok: false, message: "Write the draft before publishing it." };
  if (draft.publishedSkillId) {
    return { ok: false, message: "This draft has already been published." };
  }

  /**
   * The pre-publish gate (R4.5).
   *
   * Checked against the preview validation the draft already carries, so an author is
   * refused *before* anything is stored rather than after. The full pass still runs below —
   * this only stops an obviously blocked draft from creating rows it will fail out of.
   */
  if (draft.validation?.blocked) {
    return {
      ok: false,
      message:
        "This draft has a blocking finding. Fix it and write the draft again before publishing.",
    };
  }

  const description = String(draft.frontmatter.description ?? draft.summary ?? "");
  const name = String(draft.frontmatter.name ?? draft.slug);

  const file = renderDialect(
    { name: draft.name, slug: name, description, body: draft.body },
    draft.dialect as DialectId,
  );

  const stored = await storeBundle({
    files: [file],
    tier: "public",
    // The author's own bytes in the author's own workspace. Not `unresolved`, which means
    // "we could not tell" and would forbid storing the thing we just helped write.
    redistribution: "mirror_allowed",
    licenseSpdx: null,
  });

  const sourceId = await builderSourceId(orgId);

  const created = await withExplicitOrgScope(orgId, async (tx) => {
    const [skill] = await tx
      .insert(skills)
      .values({
        orgId,
        dialect: draft.dialect as typeof skills.dialect.enumValues[number],
        name: draft.name,
        slug: draft.slug,
        summary: description || null,
        status: "pending",
      })
      .returning({ id: skills.id, slug: skills.slug });

    const [version] = await tx
      .insert(skillVersions)
      .values({
        orgId,
        skillId: skill.id,
        sourceId,
        contentHash: stored.contentHash,
        storageKey: stored.storageKey,
        contentStored: stored.contentStored,
        byteSize: stored.byteSize,
        fileCount: stored.fileCount,
        frontmatter: { name, description },
        /**
         * Lineage, which R6.1 asks for by name.
         *
         * The archetype category and version are the part that matters: archetypes move as
         * the corpus grows, and a skill that cannot say which skeleton it was written from
         * cannot later be compared against a newer one — which is the whole premise of
         * R6.2's feedback loop.
         *
         * `sourceUrl` points at the draft rather than at a repository. It is never fetched
         * (`contentStored` is true so `loadBundle` reads storage), and pointing it at a real
         * place beats a placeholder that looks like a broken URL.
         */
        provenance: {
          authoredHere: true,
          draftId: draft.id,
          archetypeCategory: draft.archetypeCategory,
          archetypeVersion: draft.archetypeVersion,
          domainCategory: draft.domainCategory,
          model: draft.model,
          createdBy: userId,
          sourceUrl: `${getAppUrl()}/build/${draft.id}`,
          path: file.path,
          commitSha: stored.contentHash,
          files: [file.path],
          fileHashes: stored.fileHashes,
          fetchedAt: new Date().toISOString(),
        },
        licenseSpdx: null,
        licenseSource: "authored",
        licenseEvidence: null,
        redistribution: "mirror_allowed",
        upstreamRef: null,
        // `pending` is the point. The validator picks it up exactly as it picks up a skill
        // that was fetched from GitHub a second ago.
        status: "pending",
      })
      .returning({ id: skillVersions.id });

    await tx
      .update(skills)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(skills.id, skill.id));

    await tx
      .update(skillDrafts)
      .set({ publishedSkillId: skill.id, publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(skillDrafts.id, draft.id));

    /**
     * The audit row goes inside the transaction, not after it.
     *
     * Two reasons, and the second was found by the verification script. It belongs with the
     * rows it describes — a skill that exists with no record of who published it is exactly
     * the gap R7.1 exists to close. And `events` is org-scoped under RLS, so an insert
     * outside this scope is refused outright: written after the transaction with a plain
     * `db` handle it raised `new row violates row-level security policy`, which would have
     * failed every real publish, not only the test.
     */
    await tx.insert(events).values({
      orgId,
      actorType: "user",
      actorId: userId,
      kind: "builder.published",
      subjectType: "skill_versions",
      subjectId: version.id,
      reason: `published from draft ${draft.id.slice(0, 8)}`,
      payload: {
        draftId: draft.id,
        archetypeCategory: draft.archetypeCategory,
        archetypeVersion: draft.archetypeVersion,
        dialect: draft.dialect,
      },
    });

    return { skillId: skill.id, slug: skill.slug, versionId: version.id };
  });

  /**
   * The same validator, on the same table, by id.
   *
   * `validatePending` is what the pipeline runs over freshly synced versions. Handing it
   * one id is not a shortcut around it — it is the documented way to target a slice, and it
   * means an authored skill is judged by identical code, writes identical verdicts and
   * lands in `indexed` or `quarantined` by identical rules.
   */
  const { validatePending } = await import("@/server/validation/run");
  const [outcome] = await validatePending({ versionIds: [created.versionId], orgId });

  if (!outcome) {
    return { ok: false, message: "Published, but validation did not run. Try re-validating." };
  }

  /**
   * Creation telemetry (R6.2), recorded after validation because the outcome is half of it.
   *
   * G3 asks which archetype elements correlate with **first-pass** validation success, so
   * the signal cannot be written before the first pass has happened. Survival is read from
   * the published body by looking for a heading matching each offered role — the same
   * role-normalisation the structural extractor uses, so "kept" here means the same thing
   * it means everywhere else.
   *
   * Failing to record telemetry must never fail a publish. The skill exists and is valid;
   * losing one row of learning signal is not worth telling the author their skill did not
   * publish.
   */
  try {
    const { recordSignals } = await import("./telemetry");
    const { roleFromRules } = await import("@/server/analytics/structure");

    const presentRoles: Set<string> = new Set(
      (draft.body.match(/^#{2,6}\s+(.+)$/gm) ?? [])
        .map((heading) => roleFromRules(heading.replace(/^#+\s+/, "")))
        .filter((role) => role !== null),
    );

    await withExplicitOrgScope(orgId, (tx) =>
      recordSignals(tx, {
        orgId,
        draftId: draft.id,
        skillId: created.skillId,
        category: draft.archetypeCategory,
        archetypeVersion: draft.archetypeVersion,
        firstPassValid: outcome.status === "indexed",
        sections: draft.scaffoldSections.map((role) => ({
          role,
          offered: true,
          authored: Boolean(draft.sectionInputs[role]?.trim()),
          survived: presentRoles.has(role),
        })),
      }),
    );
  } catch (error) {
    console.warn(`[builder] telemetry not recorded for ${draft.id}: ${(error as Error).message}`);
  }

  return {
    ok: true,
    skillId: created.skillId,
    slug: created.slug,
    status: outcome.status,
    qualityScore: outcome.qualityScore,
    reasons: outcome.reasons,
  };
}
