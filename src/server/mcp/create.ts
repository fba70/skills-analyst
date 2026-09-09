import "server-only";

import { eq } from "drizzle-orm";

import { BLOCK_TYPES, isBlockType } from "@/lib/block-types";
import type { DraftBlockInput } from "@/lib/draft-blocks";
import { importDraftBody, setDraftBlocks } from "@/server/builder/blocks";
import { validateDraftBody } from "@/server/builder/validate-body";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { db } from "@/server/db";
import { mcpTokens, skillDrafts } from "@/server/db/schema";
import { getAppUrl } from "@/lib/app-url";
import { slugify } from "@/server/skills/normalize";
import { isValidCategory } from "@/server/taxonomy/vocabulary";

/**
 * Agent-side skill creation (Doc 2 RM.3, plan step F3) — Pro.
 *
 * The entitlement key has been live and unused since A5, waiting for two things. One was a
 * paywall to hang it on; the other was C1, because a skill created from inside an agent session
 * has to arrive as **typed blocks** or it would be the one authoring path that produces a body
 * string, and every Compose surface would have to special-case it.
 *
 * ## It creates a draft. It does not publish.
 *
 * That boundary is the whole safety design, and it is the same one B2 draws for public writes:
 * **recording and deciding are separate actions.** Publishing runs the validators, writes corpus
 * rows and makes something downloadable; an agent doing that unattended is a stranger's prompt
 * away from putting a document into a workspace's registry. So the tool returns a draft and a URL,
 * and a person opens it.
 *
 * That is not a hedge about capability. It is what makes the feature safe enough to sell.
 *
 * ## Validated on arrival, and the findings come back
 *
 * `validateDraftBody` is the same function `/build` runs (R4.5) — the same analyzers, including
 * the secret scan and the injection scan. An agent that writes a credential into a skill learns
 * so **in the tool's response**, where it can fix it, rather than when a human opens the draft
 * three days later. Reusing the real validator rather than a lighter check is R6.1's argument
 * applied one layer earlier.
 *
 * ## Attribution is the token's owner, and there is no other honest answer
 *
 * An MCP principal carries a token and an organisation, never a user — the token *is* the
 * identity. `created_by` therefore records whoever created the token: the person who authorised
 * an agent to write here. That is a real account, which is what the foreign key wants, and it is
 * the truest available statement of who is responsible.
 */

export const MAX_CREATE_BLOCKS = 40;
export const MAX_BLOCK_CHARS = 4_000;

export type CreateSkillInput = {
  tokenId: string;
  organizationId: string;
  name: string;
  purpose: string;
  category: string;
  domain?: string | null;
  /** Typed blocks, preferred — the agent has read the grammar from `get_archetype`. */
  blocks?: Array<{ type?: string | null; heading?: string | null; text?: string | null }>;
  /** Markdown, for an agent that composed prose. Tiled into typed blocks on the way in. */
  body?: string | null;
};

export type CreateSkillResult =
  | {
      ok: true;
      draftId: string;
      url: string;
      blocks: number;
      quality: number | null;
      blocked: boolean;
      findings: Array<{ analyzer: string; severity: string; message: string }>;
    }
  | { ok: false; error: string };

export async function createSkillFromAgent(
  input: CreateSkillInput,
): Promise<CreateSkillResult> {
  const name = input.name.trim();
  if (name.length < 3) return { ok: false, error: "Give the skill a name of at least 3 characters." };
  if (!input.purpose.trim()) return { ok: false, error: "Say in a line what the skill is for." };
  if (!isValidCategory("function", input.category)) {
    return { ok: false, error: `Not a function category: ${input.category}. Call list_archetypes.` };
  }
  if (input.domain && !isValidCategory("domain", input.domain)) {
    return { ok: false, error: `Not a domain category: ${input.domain}.` };
  }

  const supplied = input.blocks ?? [];
  if (supplied.length > MAX_CREATE_BLOCKS) {
    return { ok: false, error: `At most ${MAX_CREATE_BLOCKS} blocks in one call.` };
  }
  if (supplied.length === 0 && !input.body?.trim()) {
    return { ok: false, error: "Provide either `blocks` or `body`." };
  }

  /*
   * The token's creator, because a principal has no user.
   *
   * `created_by` is a foreign key to a real account — F2 learned that the hard way when a webhook
   * tried to write its own name into one — so this resolves an id or writes null, and never a
   * string that looks like an actor.
   */
  const [token] = await db
    .select({ createdBy: mcpTokens.createdBy })
    .from(mcpTokens)
    .where(eq(mcpTokens.id, input.tokenId))
    .limit(1);
  const createdBy = token?.createdBy ?? null;

  const draftId = await withExplicitOrgScope(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({
        orgId: input.organizationId,
        createdBy,
        name,
        slug: slugify(name),
        purpose: input.purpose.trim(),
        archetypeCategory: input.category,
        domainCategory: input.domain ?? null,
        sectionInputs: {},
        scaffoldSections: [],
        /*
         * `ready`, because the document exists. It was never `collecting` — nobody filled in a
         * form — and calling it that would make the loop panel count an agent's draft as a
         * half-finished human one.
         */
        status: "ready",
      })
      .returning({ id: skillDrafts.id });
    return row.id;
  });

  /* Through the one writer, exactly as a generation and an import both are. */
  const written =
    supplied.length > 0
      ? await setDraftBlocks(draftId, input.organizationId, normalise(supplied), {
          reason: "generated",
          note: "created over MCP",
          createdBy,
        })
      : await importDraftBody(draftId, input.organizationId, input.body!.trim(), {
          reason: "generated",
          note: "created over MCP",
          createdBy,
        });

  /*
   * The same validator `/build` runs, and its findings travel back in the response.
   *
   * An agent that wrote a credential into a skill can fix it now. Learning about it when a human
   * opens the draft on Thursday is the same information arriving too late to be useful to the
   * only party that could act on it cheaply.
   */
  const validation = await validateDraftBody({
    name,
    description: input.purpose.trim(),
    body: written.body,
    dialect: "anthropic_skill",
  });

  await withExplicitOrgScope(input.organizationId, async (tx) => {
    await tx
      .update(skillDrafts)
      .set({ validation, qualityScore: validation.qualityScore, summary: input.purpose.trim().slice(0, 300) })
      .where(eq(skillDrafts.id, draftId));
  });

  return {
    ok: true,
    draftId,
    url: `${getAppUrl()}/build/${draftId}`,
    blocks: written.blocks.length,
    quality: validation.qualityScore,
    blocked: validation.blocked,
    findings: validation.findings.slice(0, 10).map((finding) => ({
      analyzer: finding.analyzer,
      severity: finding.severity,
      message: finding.message,
    })),
  };
}

/**
 * An agent's blocks, normalised to the writer's shape.
 *
 * An unrecognised type becomes `null` rather than a refusal. `block-types.ts` keeps null a
 * first-class answer precisely so a workbench never refuses to hold a paragraph, and refusing an
 * agent's whole call over one mislabelled block would be that risk arriving through a new door —
 * Doc 6 §7's over-structuring, enforced on a machine that cannot ask what went wrong.
 */
function normalise(
  blocks: NonNullable<CreateSkillInput["blocks"]>,
): DraftBlockInput[] {
  const out: DraftBlockInput[] = [];
  for (const block of blocks) {
    const heading = block.heading?.trim();
    if (heading) out.push({ form: "heading", depth: 2, type: null, text: heading });
    const text = block.text?.trim();
    if (!text) continue;
    out.push({
      form: "content",
      depth: null,
      type: isBlockType(block.type) ? block.type : null,
      text: text.slice(0, MAX_BLOCK_CHARS),
    });
  }
  return out;
}

/** The block vocabulary, for the tool's own schema. Derived, never a second list. */
export const CREATE_BLOCK_TYPES = BLOCK_TYPES;
