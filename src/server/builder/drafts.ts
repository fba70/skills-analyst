import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { events, skillDrafts } from "@/server/db/schema";
import { db } from "@/server/db";
import { withExplicitOrgScope, withOrgScope } from "@/server/dal/scope";
import { labelFor } from "@/server/taxonomy/vocabulary";

import { importDraftBody } from "./blocks";
import { buildScaffold } from "./scaffold";
import { generateDraft } from "./generate";
import type { DraftValidation } from "./validate-body";

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
  publishedSkillId: string | null;
  qualityScore: number | null;
  updatedAt: Date;
};

export type DraftDetail = DraftSummary & {
  dialect: string;
  archetypeVersion: number | null;
  purpose: string;
  context: string | null;
  sectionInputs: Record<string, string>;
  scaffoldSections: string[];
  body: string | null;
  frontmatter: Record<string, unknown>;
  model: string | null;
  failureReason: string | null;
  validation: DraftValidation | null;
  /** Set once the draft has become a skill (R6.1). Never cleared. */
  publishedSkillId: string | null;
  publishedAt: Date | null;
};

export type { DraftValidation } from "./validate-body";

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
        publishedSkillId: skillDrafts.publishedSkillId,
        qualityScore: skillDrafts.qualityScore,
        updatedAt: skillDrafts.updatedAt,
      })
      .from(skillDrafts)
      .orderBy(desc(skillDrafts.updatedAt))
      .limit(limit),
  );
}

/**
 * `orgId` scopes explicitly instead of resolving a session.
 *
 * For callers that already know the organisation — publishing is handed one — and for
 * background work with no session at all. `withOrgScope` would re-derive what the caller
 * already has, and re-deriving it needs `next/navigation`, which is why the alternative
 * exists at all.
 */
export async function getDraft(id: string, orgId?: string): Promise<DraftDetail | null> {
  const scope = orgId
    ? <T,>(fn: Parameters<typeof withOrgScope<T>>[0]) => withExplicitOrgScope(orgId, fn)
    : withOrgScope;
  return scope(async (tx) => {
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
      scaffoldSections: (row.scaffoldSections ?? []) as string[],
      body: row.body,
      frontmatter: (row.frontmatter ?? {}) as Record<string, unknown>,
      model: row.model,
      failureReason: row.failureReason,
      validation: (row.validation ?? null) as DraftValidation | null,
      publishedSkillId: row.publishedSkillId,
      publishedAt: row.publishedAt,
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
  /** Roles the scaffold proposed, so R6.2 can later ask which survived. */
  scaffoldSections: string[];
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
  return applyCreate(input, orgId, session.user.id);
}

async function applyCreate(
  input: CreateDraftInput,
  orgId: string,
  userId: string,
): Promise<string> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({
        orgId,
        createdBy: userId,
        name: input.name.trim(),
        slug: slugify(input.name),
        purpose: input.purpose.trim(),
        context: input.context?.trim() || null,
        archetypeCategory: input.category,
        domainCategory: input.domain,
        dialect: input.dialect as typeof skillDrafts.dialect.enumValues[number],
        sectionInputs: input.sectionInputs,
        scaffoldSections: input.scaffoldSections,
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
  // Resolved here rather than passed in: the caller is a server action that already has a
  // session, and the budget must be charged to the workspace that owns the draft (RC.2).
  const { requireSession } = await import("@/server/dal/session");
  const session = await requireSession();
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { ok: false, message: "No active workspace." };
  return applyGenerate(draftId, orgId);
}

/**
 * Test seams, matching `publishForTest` and `upholdForTest` elsewhere.
 *
 * They skip `requireSession()` and nothing else — the rows written, the model called and
 * the budget charged are identical. `requireSession` reaches `next/navigation`, which
 * cannot load in a plain node process, and that is the only reason these exist.
 */
export const createForTest = (input: CreateDraftInput, orgId: string, userId: string) =>
  applyCreate(input, orgId, userId);
export const generateForTest = (draftId: string, orgId: string) =>
  applyGenerate(draftId, orgId);

async function applyGenerate(draftId: string, orgId: string): Promise<GenerateResult> {
  const draft = await getDraft(draftId, orgId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (draft.status === "generating") {
    return { ok: false, message: "This draft is already being written." };
  }

  const scaffold = await buildScaffold(draft.archetypeCategory);
  if (!scaffold) return { ok: false, message: "Unknown category." };

  await withExplicitOrgScope(orgId, async (tx) => {
    await tx
      .update(skillDrafts)
      .set({ status: "generating", failureReason: null, updatedAt: new Date() })
      .where(eq(skillDrafts.id, draftId));
  });

  try {
    const generated = await generateDraft({
      orgId,
      scaffold,
      purpose: draft.purpose,
      context: draft.context,
      sectionInputs: draft.sectionInputs,
      dialect: draft.dialect,
      domainLabel: draft.domainCategory ? labelFor("domain", draft.domainCategory) : null,
    });

    if (generated.refusal) {
      await withExplicitOrgScope(orgId, async (tx) => {
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

    /*
     * Metadata first, blocks second, and the order is load-bearing.
     *
     * `importDraftBody` validates the document it renders, and validation needs the
     * frontmatter this generation just produced — a name and a description. Importing before
     * storing them would judge the new body against the previous generation's frontmatter,
     * which on a first generation is no frontmatter at all: `missing-name` findings on a
     * document that has a name.
     *
     * `body` is deliberately absent from this update. It is written by exactly one code path
     * — see `blocks.ts` — because a body that is both stored and derived drifts from the
     * blocks the author edits, and nothing errors when it does.
     */
    await withExplicitOrgScope(orgId, async (tx) => {
      await tx
        .update(skillDrafts)
        .set({
          summary: generated.description,
          frontmatter: { name: generated.frontmatterName, description: generated.description },
          model: generated.model,
          generatedAt: new Date(),
          archetypeVersion: scaffold.archetypeVersion,
          updatedAt: new Date(),
        })
        .where(eq(skillDrafts.id, draftId));
    });

    /*
     * The generated string is segmented into typed blocks and the body becomes their render
     * (plan step C1). The author now edits parts of a document rather than a wall of text,
     * and the archetype's block grammar can be compared against what they actually wrote.
     *
     * No new detector: `extractStructure` does the typing, the same extractor behind every
     * corpus block and behind `blockDeviations`.
     */
    const { validation } = await importDraftBody(draftId, orgId, generated.body, {
      reason: "generated",
      note: generated.model,
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
    /**
     * A budget refusal is not a failure of the draft (RC.2).
     *
     * The inputs are fine and will work next month or after the cap is raised, so the draft
     * stays `collecting` rather than being marked `failed` — a red "not written" card with
     * a billing message underneath would tell the author to fix something that is not
     * broken. The message is passed through verbatim because it already carries the cap,
     * the spend and the reset date, which is the clear UX the requirement asks for.
     */
    const { BudgetExceededError } = await import("@/server/billing/spend");
    if (error instanceof BudgetExceededError) {
      await withExplicitOrgScope(orgId, async (tx) => {
        await tx
          .update(skillDrafts)
          .set({ status: "collecting", failureReason: error.message, updatedAt: new Date() })
          .where(eq(skillDrafts.id, draftId));
      });
      return { ok: false, message: error.message };
    }

    const message = (error as Error).message.slice(0, 300);
    await withExplicitOrgScope(orgId, async (tx) => {
      await tx
        .update(skillDrafts)
        .set({ status: "failed", failureReason: message, updatedAt: new Date() })
        .where(eq(skillDrafts.id, draftId));
    });
    return { ok: false, message };
  }
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
