import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { events, skillDrafts } from "@/server/db/schema";
import { db } from "@/server/db";
import { withOrgScope } from "@/server/dal/scope";
import { SEVERITY_WEIGHTS, substanceFactor } from "@/lib/quality";
import { labelFor } from "@/server/taxonomy/vocabulary";

import { buildScaffold } from "./scaffold";
import { generateDraft } from "./generate";

/**
 * Draft persistence and the generate step (Doc 2 R4.1–R4.5).
 *
 * Every read and write goes through `withOrgScope`, so each runs inside a transaction that
 * has declared which org is asking and Postgres filters the rows. `skill_drafts.org_id` is
 * NOT NULL and its policy has no `IS NULL` escape hatch, so a request with no session sees
 * nothing at all — which is the correct answer for a table that has no public rows.
 */

export type DraftSummary = {
  id: string;
  name: string;
  slug: string;
  summary: string | null;
  status: string;
  archetypeCategory: string;
  domainCategory: string | null;
  qualityScore: number | null;
  updatedAt: Date;
};

export type DraftDetail = DraftSummary & {
  dialect: string;
  archetypeVersion: number | null;
  purpose: string;
  context: string | null;
  sectionInputs: Record<string, string>;
  body: string | null;
  frontmatter: Record<string, unknown>;
  model: string | null;
  failureReason: string | null;
  validation: DraftValidation | null;
};

export type DraftValidation = {
  qualityScore: number;
  blocked: boolean;
  findings: Array<{ analyzer: string; reason: string; severity: string; message: string }>;
};

export async function listDrafts(limit = 10): Promise<DraftSummary[]> {
  return withOrgScope(async (tx) =>
    tx
      .select({
        id: skillDrafts.id,
        name: skillDrafts.name,
        slug: skillDrafts.slug,
        summary: skillDrafts.summary,
        status: skillDrafts.status,
        archetypeCategory: skillDrafts.archetypeCategory,
        domainCategory: skillDrafts.domainCategory,
        qualityScore: skillDrafts.qualityScore,
        updatedAt: skillDrafts.updatedAt,
      })
      .from(skillDrafts)
      .orderBy(desc(skillDrafts.updatedAt))
      .limit(limit),
  );
}

export async function getDraft(id: string): Promise<DraftDetail | null> {
  return withOrgScope(async (tx) => {
    const [row] = await tx.select().from(skillDrafts).where(eq(skillDrafts.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      summary: row.summary,
      status: row.status,
      dialect: row.dialect,
      archetypeCategory: row.archetypeCategory,
      domainCategory: row.domainCategory,
      archetypeVersion: row.archetypeVersion,
      purpose: row.purpose,
      context: row.context,
      sectionInputs: (row.sectionInputs ?? {}) as Record<string, string>,
      body: row.body,
      frontmatter: (row.frontmatter ?? {}) as Record<string, unknown>,
      model: row.model,
      failureReason: row.failureReason,
      validation: (row.validation ?? null) as DraftValidation | null,
      qualityScore: row.qualityScore,
      updatedAt: row.updatedAt,
    };
  });
}

export type CreateDraftInput = {
  name: string;
  purpose: string;
  context: string | null;
  category: string;
  /** Optional: a skill can be genuinely domain-neutral, and a guess would mislabel it. */
  domain: string | null;
  dialect: string;
  sectionInputs: Record<string, string>;
};

/**
 * Records what the author typed, before anything is generated.
 *
 * Saved first and separately, so the expensive, failable half has something to retry from.
 * An author who fills in eight sections and then hits a model timeout should lose the
 * generation, never their own words.
 */
export async function createDraft(input: CreateDraftInput): Promise<string> {
  const { requireSession } = await import("@/server/dal/session");
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) throw new Error("No active workspace.");

  return withOrgScope(async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({
        orgId,
        createdBy: session.user.id,
        name: input.name.trim(),
        slug: slugify(input.name),
        purpose: input.purpose.trim(),
        context: input.context?.trim() || null,
        archetypeCategory: input.category,
        domainCategory: input.domain,
        dialect: input.dialect as typeof skillDrafts.dialect.enumValues[number],
        sectionInputs: input.sectionInputs,
        status: "collecting",
      })
      .returning({ id: skillDrafts.id });
    return row.id;
  });
}

export type GenerateResult =
  | { ok: true; refused: false; draftId: string }
  | { ok: true; refused: true; draftId: string; reason: string }
  | { ok: false; message: string };

/**
 * Generates the body, validates it, stores both.
 *
 * ## The status is written before the model is called
 *
 * `generating` is persisted first. The call takes seconds inside a server action, and
 * without a durable state a reload mid-flight shows a draft that looks untouched — which
 * invites a second, billable attempt at the same document. This is also the guard against
 * two clicks: a draft already `generating` is refused rather than re-sent.
 *
 * ## A refusal is stored, not thrown
 *
 * R5.5 wants refusals logged. Storing the reason on the draft means the author sees why
 * rather than a generic error, and the `events` row makes it auditable — which is what
 * makes "the assistant refuses malicious authoring" a claim anyone can check.
 */
export async function generateForDraft(draftId: string): Promise<GenerateResult> {
  const draft = await getDraft(draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status === "generating") {
    return { ok: false, message: "This draft is already being written." };
  }

  const scaffold = await buildScaffold(draft.archetypeCategory);
  if (!scaffold) return { ok: false, message: "Unknown category." };

  await withOrgScope(async (tx) => {
    await tx
      .update(skillDrafts)
      .set({ status: "generating", failureReason: null, updatedAt: new Date() })
      .where(eq(skillDrafts.id, draftId));
  });

  try {
    const generated = await generateDraft({
      scaffold,
      purpose: draft.purpose,
      context: draft.context,
      sectionInputs: draft.sectionInputs,
      dialect: draft.dialect,
      domainLabel: draft.domainCategory ? labelFor("domain", draft.domainCategory) : null,
    });

    if (generated.refusal) {
      await withOrgScope(async (tx) => {
        await tx
          .update(skillDrafts)
          .set({ status: "failed", failureReason: generated.refusal, updatedAt: new Date() })
          .where(eq(skillDrafts.id, draftId));
      });
      await db.insert(events).values({
        actorType: "system",
        actorId: "builder.assistant",
        kind: "builder.refused",
        subjectType: "skill_drafts",
        subjectId: draftId,
        reason: generated.refusal,
        payload: { category: draft.archetypeCategory, model: generated.model },
      });
      return { ok: true, refused: true, draftId, reason: generated.refusal };
    }

    const validation = await validateBody({
      name: generated.frontmatterName,
      description: generated.description,
      body: generated.body,
      dialect: draft.dialect,
    });

    await withOrgScope(async (tx) => {
      await tx
        .update(skillDrafts)
        .set({
          status: "ready",
          body: generated.body,
          summary: generated.description,
          frontmatter: { name: generated.frontmatterName, description: generated.description },
          model: generated.model,
          generatedAt: new Date(),
          validation,
          qualityScore: validation.qualityScore,
          archetypeVersion: scaffold.archetypeVersion,
          updatedAt: new Date(),
        })
        .where(eq(skillDrafts.id, draftId));
    });

    await db.insert(events).values({
      actorType: "system",
      actorId: "builder.assistant",
      kind: "builder.generated",
      subjectType: "skill_drafts",
      subjectId: draftId,
      reason: `${draft.archetypeCategory} · quality ${validation.qualityScore}`,
      payload: {
        category: draft.archetypeCategory,
        archetypeVersion: scaffold.archetypeVersion,
        model: generated.model,
        blocked: validation.blocked,
      },
    });

    return { ok: true, refused: false, draftId };
  } catch (error) {
    const message = (error as Error).message.slice(0, 300);
    await withOrgScope(async (tx) => {
      await tx
        .update(skillDrafts)
        .set({ status: "failed", failureReason: message, updatedAt: new Date() })
        .where(eq(skillDrafts.id, draftId));
    });
    return { ok: false, message };
  }
}

/**
 * Runs the free analyzers over the generated document (R4.5).
 *
 * The same analyzers the corpus is judged by, on a bundle that exists only in memory —
 * `AnalyzerInput` takes files rather than a storage key, so a draft can be validated
 * before it has ever been written anywhere. A builder that produced skills held to a lower
 * standard than the registry it publishes into would undermine both.
 *
 * The costly R2.3 consistency audit is not run here. It is opt-in for the corpus for the
 * same reason it should be opt-in here — and it compares documentation against *bundled
 * code*, which a text-only first draft does not have.
 */
async function validateBody(input: {
  name: string;
  description: string;
  body: string;
  dialect: string;
}): Promise<DraftValidation> {
  const { runAnalyzersOnBundle } = await import("@/server/validation/run");

  const markdown = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body}\n`;
  const findings = await runAnalyzersOnBundle({
    files: [{ path: "SKILL.md", content: Buffer.from(markdown, "utf8") }],
    body: input.body,
    frontmatter: { name: input.name, description: input.description },
    markerPath: "SKILL.md",
    dialect: input.dialect,
    resolvedName: input.name,
    resolvedSummary: input.description,
    // We wrote the frontmatter ourselves from structured fields, so there is nothing to
    // have failed to parse. Null is the honest value, not a placeholder.
    parseError: null,
  });

  const penalty = findings.reduce(
    (total, f) => total + (SEVERITY_WEIGHTS[f.severity as keyof typeof SEVERITY_WEIGHTS] ?? 0),
    0,
  );
  const defectScore = Math.max(0, Math.min(100, 100 - penalty));
  const qualityScore = Math.round(
    defectScore * substanceFactor(Buffer.byteLength(input.body, "utf8")),
  );

  return {
    qualityScore,
    blocked: findings.some((f) => f.severity === "high" || f.severity === "critical"),
    findings,
  };
}

/** `Name of Thing` → `name-of-thing`, uniqueness left to the org scope. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled-skill"
  );
}

/** Counts for the dashboard, so "Your skills" reflects drafts rather than an empty table. */
export async function draftCounts() {
  return withOrgScope(async (tx) => {
    const [row] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        ready: sql<number>`count(*) filter (where ${skillDrafts.status} = 'ready')::int`,
      })
      .from(skillDrafts)
      .where(and(sql`true`));
    return row ?? { total: 0, ready: 0 };
  });
}
