import "server-only";

import { randomUUID } from "node:crypto";

import { asc, desc, eq, sql } from "drizzle-orm";

import { isBlockType, type BlockType } from "@/lib/block-types";
import {
  clampDepth,
  diffDraftBlocks,
  isDraftBlockForm,
  renderDraftBody,
  type DraftBlock,
  type DraftBlockChange,
  type DraftBlockForm,
  type DraftBlockInput,
  type RevisionReason,
} from "@/lib/draft-blocks";
import { isBlockRule, type BlockRule } from "@/lib/parameters";
import { headingSpans } from "@/server/analytics/blocks";
import { extractStructure } from "@/server/analytics/structure";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { draftBlocks, draftRevisions, skillDrafts } from "@/server/db/schema";

import { validateDraftBody, type DraftValidation } from "./validate-body";

/**
 * A draft's blocks: importing a body into them, and writing them back (plan step C1).
 *
 * ## The one writer of `skill_drafts.body`
 *
 * Blocks are the source and the body is a render. That is only true while exactly one code
 * path writes the column, and this module is it — `setDraftBlocks` renders and stores both
 * in the same transaction, so there is no instant at which the two disagree. Everything
 * downstream keeps taking a body and never learns blocks exist: publish-back hands it to the
 * real validator (R6.1), export hands it to the real archive builder (R4.4), and a
 * block-aware version of either would be a second definition of "servable".
 *
 * `verify:draft-blocks` asserts the single-writer property by reading the source tree, not
 * by trusting this comment. The failure it exists to catch is silent by construction: a
 * second writer produces a document that renders differently from the blocks the author
 * edited, and nothing errors — the first sign is somebody publishing a document they did not
 * write.
 */

export type { DraftBlock } from "@/lib/draft-blocks";

/**
 * Tile a body into draft blocks (R4.7's import, and every generation).
 *
 * ## No new detector, and one that had to be added anyway
 *
 * The *typing* is `extractStructure` — the same extractor behind all 1.6 million corpus
 * blocks, the same one `blockDeviations` already runs over a draft body. Nothing here
 * reimplements segmentation, for the reason that comparison exists at all: a second, lighter
 * detector would drift, and every drift would surface as a deviation the author cannot act
 * on.
 *
 * What the extractor cannot supply is a **contiguous** cover. It treats a heading as a
 * boundary rather than a block — correctly, since the heading is already the fingerprint's
 * own unit and emitting it twice would double-count every section — and it skips blank lines
 * and horizontal rules as punctuation. Concatenating its spans therefore reassembles a
 * document with **every heading gone**, which is fine for measuring a corpus and fatal for
 * storing a draft.
 *
 * So the typed spans are merged with `headingSpans` (collected by that same segmenter, so
 * fences are handled once) and the gaps between them are read straight out of the body. A
 * gap is `body.slice(...)`, not a parse: the only non-whitespace thing that lands in one is a
 * horizontal rule, and it survives as an untyped block rather than being silently deleted.
 *
 * The result tiles the document, so `renderDraftBody(tileDraftBody(b))` reproduces `b` line
 * for line. `verify:draft-blocks` reproduces the heading loss first and then asserts that.
 */
export function tileDraftBody(body: string): DraftBlockInput[] {
  const fingerprint = extractStructure({
    body,
    frontmatter: {},
    /*
     * A synthetic one-file bundle, because that is what a draft is. `bundlePaths` therefore
     * holds only the marker, which makes a pointer to `references/foo.md` resolve as a link
     * to something absent — correct rather than a limitation, and the same synthetic bundle
     * `blockDeviations` builds for the same reason.
     */
    files: [{ path: "SKILL.md", content: Buffer.from(body, "utf8") }],
    markerPath: "SKILL.md",
  });

  type Piece = { start: number; end: number; block: DraftBlockInput };
  const pieces: Piece[] = [];

  for (const heading of headingSpans(body)) {
    pieces.push({
      start: heading.startChar,
      end: heading.endChar,
      block: { form: "heading", depth: heading.depth, type: null, text: heading.text },
    });
  }
  for (const block of fingerprint.blocks) {
    pieces.push({
      start: block.startChar,
      end: block.endChar,
      block: {
        form: "content",
        depth: null,
        type: block.type,
        text: body.slice(block.startChar, block.endChar),
      },
    });
  }
  pieces.sort((a, b) => a.start - b.start || a.end - b.end);

  const out: DraftBlockInput[] = [];
  let cursor = 0;
  const keepGap = (from: number, to: number): void => {
    if (to <= from) return;
    const gap = body.slice(from, to).trim();
    if (gap.length > 0) out.push({ form: "content", depth: null, type: null, text: gap });
  };

  for (const piece of pieces) {
    // Spans cannot overlap — headings are excluded from segments by construction — but the
    // guard costs nothing and turns a future segmenter change into a duplicated block rather
    // than a negative slice.
    if (piece.start < cursor) continue;
    keepGap(cursor, piece.start);
    out.push(piece.block);
    cursor = piece.end;
  }
  keepGap(cursor, body.length);

  return out;
}

/** Read a draft's blocks in document order. */
export async function getDraftBlocks(draftId: string, orgId: string): Promise<DraftBlock[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(draftBlocks)
      .where(eq(draftBlocks.draftId, draftId))
      .orderBy(asc(draftBlocks.blockOrder));
    return rows.map((row) => ({
      id: row.id,
      order: row.blockOrder,
      form: isDraftBlockForm(row.form) ? row.form : "content",
      depth: row.depth,
      type: isBlockType(row.type) ? row.type : null,
      text: row.text,
      sharedBlockId: row.sharedBlockId,
      sharedBlockVersion: row.sharedBlockVersion,
      /* Validated on the way out: a row hand-edited into a bad shape reads as prose, not as a crash. */
      rule: isBlockRule(row.rule) ? row.rule : null,
    }));
  });
}

export type SetBlocksResult = {
  blocks: DraftBlock[];
  body: string;
  validation: DraftValidation;
  /** The revision this save produced, or null when nothing about the document changed. */
  revision: number | null;
};

export type SetBlocksOptions = {
  reason?: RevisionReason;
  note?: string | null;
  createdBy?: string | null;
};

/**
 * Replace a draft's blocks, and render the body from them.
 *
 * ## Replaced, not upserted
 *
 * `skill_blocks` reached the same conclusion from the other direction: there, the row *count*
 * changes when the extractor's rules change, so there is no key an upsert could target. Here
 * the count changes because the author inserted a block in the middle, and renumbering in
 * place would collide with `draft_blocks_uq` mid-statement. Delete and re-insert the whole
 * list in one transaction is correct for both reasons, and at the tens of rows a draft holds
 * it is not a performance question.
 *
 * **Ids are carried through when the caller supplies them.** C2b hangs an accept/reject
 * decision off a block and D1 hangs an eval case off one; neither can reference a row whose
 * id changes every time somebody reorders a list.
 *
 * ## Validation runs on the render, not on what was handed in
 *
 * The document that gets validated has to be the document that gets published. Validating
 * the blocks' concatenation and storing a differently-joined body would put a quality score
 * on a document nobody will ever see — the same class of mistake as a checker holding its own
 * copy of the rule it checks.
 */
export async function setDraftBlocks(
  draftId: string,
  orgId: string,
  input: ReadonlyArray<DraftBlockInput>,
  options: SetBlocksOptions = {},
): Promise<SetBlocksResult> {
  const normalised = input.map(normalise).filter((b) => b.form === "heading" || b.text.length > 0);
  const body = renderDraftBody(normalised);

  const draft = await withExplicitOrgScope(orgId, async (tx) => {
    const [row] = await tx
      .select({
        slug: skillDrafts.slug,
        name: skillDrafts.name,
        summary: skillDrafts.summary,
        dialect: skillDrafts.dialect,
        frontmatter: skillDrafts.frontmatter,
      })
      .from(skillDrafts)
      .where(eq(skillDrafts.id, draftId))
      .limit(1);
    return row ?? null;
  });
  if (!draft) throw new Error("Draft not found.");

  /*
   * Ids are decided before the write, not by the database, because the revision snapshot has
   * to carry the same ids the rows do — that identity is what makes a diff readable rather
   * than a delete-everything-add-everything list. A block the caller already knows keeps its
   * id; a new one gets a fresh uuid here so both writes agree on it.
   */
  const assigned = new Map<number, string>();
  const idFor = (block: NormalisedBlock, order: number): string => {
    const existing = assigned.get(order);
    if (existing) return existing;
    const id = block.id ?? randomUUID();
    assigned.set(order, id);
    return id;
  };

  let revision: number | null = null;

  const frontmatter = (draft.frontmatter ?? {}) as Record<string, unknown>;
  const validation = await validateDraftBody({
    name: String(frontmatter.name ?? draft.slug),
    description: String(frontmatter.description ?? draft.summary ?? ""),
    body,
    dialect: draft.dialect,
  });

  await withExplicitOrgScope(orgId, async (tx) => {
    await tx.delete(draftBlocks).where(eq(draftBlocks.draftId, draftId));
    if (normalised.length > 0) {
      await tx.insert(draftBlocks).values(
        normalised.map((block, order) => ({
          id: idFor(block, order),
          orgId,
          draftId,
          blockOrder: order,
          form: block.form,
          depth: block.form === "heading" ? clampDepth(block.depth) : null,
          type: block.form === "heading" ? null : block.type,
          text: block.text,
          /* Provenance travels with the row; a heading is never a transclusion. */
          sharedBlockId: block.form === "heading" ? null : (block.sharedBlockId ?? null),
          sharedBlockVersion: block.form === "heading" ? null : (block.sharedBlockVersion ?? null),
          /* And so does structure. A heading has none; a decision rule keeps what the author confirmed. */
          rule: block.form === "heading" ? null : block.rule,
        })),
      );
    }
    /*
     * The revision is appended inside the same transaction (R4.7).
     *
     * Outside it, a crash between the two writes would leave a document with no record of how
     * it got there — and history that is sometimes missing is history nobody checks. The same
     * argument publish-back had to make when its `events` row was written after the
     * transaction and silently refused by RLS.
     */
    const previous = await tx
      .select({ blocks: draftRevisions.blocks, revision: draftRevisions.revision })
      .from(draftRevisions)
      .where(eq(draftRevisions.draftId, draftId))
      .orderBy(desc(draftRevisions.revision))
      .limit(1);

    const priorBlocks = (previous[0]?.blocks ?? []) as DraftBlock[];
    const snapshot: DraftBlock[] = normalised.map((block, order) => ({
      id: idFor(block, order),
      order,
      form: block.form,
      depth: block.depth,
      type: block.type,
      text: block.text,
      /* In the snapshot so a restore brings the structure back with the sentence. Ignored by the diff. */
      rule: block.rule,
    }));

    /*
     * No revision when nothing about the document moved.
     *
     * An author who opens a draft, saves, and changes nothing should not add a row to their
     * own history — a list padded with no-ops is a list people stop reading, and this is the
     * surface whose whole value is that it can be scanned.
     */
    const changed =
      previous.length === 0 || diffDraftBlocks(priorBlocks, snapshot).length > 0;
    if (changed) {
      revision = (previous[0]?.revision ?? 0) + 1;
      await tx.insert(draftRevisions).values({
        orgId,
        draftId,
        revision,
        blocks: snapshot,
        reason: options.reason ?? "edited",
        note: options.note ?? null,
        createdBy: options.createdBy ?? null,
      });
    }

    await tx
      .update(skillDrafts)
      .set({
        body: body.length > 0 ? body : null,
        validation,
        qualityScore: validation.qualityScore,
        /*
         * `ready` means the document says something, not that a model was called.
         *
         * R4.6's simplified path lands here rather than needing a branch: three blocks typed
         * by hand is a legitimate document, and a status that stayed `collecting` until a
         * generation had happened would make the wizard the only real way in.
         *
         * A scaffold with nothing written in it is the case that decides the test. Its render
         * is a list of headings, which is a body — so "has a body" would call it ready, and
         * an author would see their empty outline described as finished. The condition is
         * therefore *content*: at least one non-heading block with something in it.
         */
        status: normalised.some((block) => block.form === "content" && block.text.trim())
          ? "ready"
          : "collecting",
        updatedAt: new Date(),
      })
      .where(eq(skillDrafts.id, draftId));
  });

  return { blocks: await getDraftBlocks(draftId, orgId), body, validation, revision };
}

/** Import a body into blocks and store them. Used by generation and by R5.6's import. */
export async function importDraftBody(
  draftId: string,
  orgId: string,
  body: string,
  options: SetBlocksOptions = {},
): Promise<SetBlocksResult> {
  return setDraftBlocks(draftId, orgId, tileDraftBody(body), options);
}

export type DraftRevision = {
  revision: number;
  reason: string;
  note: string | null;
  createdAt: Date;
  blockCount: number;
  /** What this revision did to the one before it. Empty on the first. */
  changes: DraftBlockChange[];
};

/**
 * A draft's history, newest first, each row carrying its diff against the one before it.
 *
 * The diffs are computed on read rather than stored, and that is the same argument the
 * archetype comparison makes on the same page: a stored summary would go on describing a
 * comparison made by an older version of the differ. It is free — an array walk over two
 * snapshots already in memory.
 */
export async function listDraftRevisions(
  draftId: string,
  orgId: string,
  limit = 20,
): Promise<DraftRevision[]> {
  return withExplicitOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        revision: draftRevisions.revision,
        reason: draftRevisions.reason,
        note: draftRevisions.note,
        createdAt: draftRevisions.createdAt,
        blocks: draftRevisions.blocks,
      })
      .from(draftRevisions)
      .where(eq(draftRevisions.draftId, draftId))
      .orderBy(desc(draftRevisions.revision))
      .limit(limit);

    return rows.map((row, index) => {
      const blocks = (row.blocks ?? []) as DraftBlock[];
      /*
       * `rows` is newest-first, so the predecessor is the *next* element. Absent for the
       * oldest row in the window, which is not the same as "nothing changed" — a truncated
       * window has a predecessor we did not fetch, and an empty change list there would read
       * as an empty revision. Hence the length check rather than a `?? []`.
       */
      const predecessor = rows[index + 1];
      return {
        revision: row.revision,
        reason: row.reason,
        note: row.note,
        createdAt: row.createdAt,
        blockCount: blocks.length,
        changes: predecessor
          ? diffDraftBlocks((predecessor.blocks ?? []) as DraftBlock[], blocks)
          : [],
      };
    });
  });
}

/**
 * Put a draft back to how it looked at one revision (R4.7).
 *
 * **Forward, never backward.** The restore is an ordinary save of the old blocks, so it
 * appends a new revision rather than truncating the history to the point restored from. An
 * author who restores revision 3 and then decides they were right the first time can still
 * reach revision 7 — and a history that deletes itself when used is a history people are
 * afraid to use.
 *
 * The block ids come back with the snapshot, so the diff against what was there reads as the
 * edits being undone rather than as the whole document being replaced.
 */
export async function restoreDraftRevision(
  draftId: string,
  orgId: string,
  revision: number,
  createdBy: string | null,
): Promise<SetBlocksResult> {
  const snapshot = await withExplicitOrgScope(orgId, async (tx) => {
    const [row] = await tx
      .select({ blocks: draftRevisions.blocks })
      .from(draftRevisions)
      .where(
        sql`${draftRevisions.draftId} = ${draftId} and ${draftRevisions.revision} = ${revision}`,
      )
      .limit(1);
    return row ? ((row.blocks ?? []) as DraftBlock[]) : null;
  });
  if (!snapshot) throw new Error(`No revision ${revision} on this draft.`);

  return setDraftBlocks(
    draftId,
    orgId,
    snapshot.map((block) => ({
      id: block.id,
      form: block.form,
      depth: block.depth,
      type: block.type,
      text: block.text,
      rule: isBlockRule(block.rule) ? block.rule : null,
    })),
    { reason: "restored", note: `restored from revision ${revision}`, createdBy },
  );
}

type NormalisedBlock = {
  id?: string;
  form: DraftBlockForm;
  depth: number | null;
  type: BlockType | null;
  text: string;
  sharedBlockId: string | null;
  sharedBlockVersion: number | null;
  rule: BlockRule | null;
};

function normalise(block: DraftBlockInput): NormalisedBlock {
  const form = isDraftBlockForm(block.form) ? block.form : "content";
  const type: BlockType | null =
    form === "heading" ? null : isBlockType(block.type) ? block.type : null;
  const text = form === "heading" ? block.text.trim() : block.text.replace(/[ \t\r\n]+$/, "");
  return {
    id: block.id,
    form,
    depth: form === "heading" ? clampDepth(block.depth) : null,
    type,
    text,
    sharedBlockId: block.sharedBlockId ?? null,
    sharedBlockVersion: block.sharedBlockVersion ?? null,
    /*
     * Only a decision rule carries structure. Retyping a block to anything else drops it, which
     * is the author saying this passage is not a rule — and a guardrail wearing a decision table
     * would be counted in coverage it has no business in.
     */
    rule: type === "decision-rule" && isBlockRule(block.rule) ? block.rule : null,
  };
}
