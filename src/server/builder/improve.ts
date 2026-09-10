import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import {
  isRedistributable,
  looksBinary,
  MAX_DRAFT_RESOURCES,
  MAX_RESOURCE_BYTES,
  safeResourcePath,
  type Attribution,
  type DraftResource,
  type ImportRefusal,
  type ImportSource,
} from "@/lib/improve";
import { getDraftBlocks, importDraftBody, setDraftBlocks } from "@/server/builder/blocks";
import { withExplicitOrgScope } from "@/server/dal/scope";
import { db } from "@/server/db";
import { draftResources, events, skillDrafts, skills, skillVersions } from "@/server/db/schema";
import { slugify, splitFrontmatter } from "@/server/skills/normalize";
import { getBundleFile, getManifest } from "@/server/storage";

/**
 * Improve an existing skill (Doc 2 R5.6, plan step C6).
 *
 * ## Almost all of this step is import, and almost all of import is licence
 *
 * Once a document is typed blocks in a draft, every Compose surface applies to it unchanged —
 * deviation marks, the block library, the scope analyser, the eval lab. Nothing here re-implements
 * any of them. What it has to get right is where the bytes came from and what is owed for them.
 *
 * `src/lib/improve.ts` carries the reasoning; the three rules it lands on are enforced here:
 * only a redistributable posture may be forked, the obligation is frozen onto the draft rather
 * than resolved by a join, and publishing a fork inherits the upstream licence instead of
 * claiming `authored`.
 *
 * ## The body still has exactly one writer
 *
 * Import goes through `importDraftBody`, the same path a generation takes, so `skill_drafts.body`
 * keeps the single writer C1 established. This module inserts resource rows and never touches
 * that column — asserted by `verify:improve` as well as by `verify:draft-blocks`, because an
 * importer holding a whole document is the most tempting place in the codebase to add a second
 * writer.
 */

export type ImportResult =
  | { ok: true; draftId: string; source: ImportSource; resources: number }
  | { ok: false; refusal: ImportRefusal };

type UploadedFile = { path: string; bytes: Uint8Array };

export type ImportInput = {
  orgId: string;
  userId: string;
  /** Fork or improve a corpus skill by slug. Mutually exclusive with `files`. */
  slug?: string;
  /** An uploaded bundle. The marker is whichever file the dialect detector would pick. */
  files?: UploadedFile[];
  /** Overrides the imported name. Optional — a fork usually keeps it. */
  name?: string;
  /** Required by the draft schema, which has no notion of an uncategorised draft. */
  category: string;
  domain?: string | null;
};

/**
 * Import a skill into a new draft.
 *
 * The order of the refusals matters: facts about the *skill* are checked before facts about the
 * bytes, because "this licence does not permit copying" is true whatever the bundle contains and
 * reading it first would be doing work to reach a refusal we already knew.
 */
export async function importSkillForImprovement(input: ImportInput): Promise<ImportResult> {
  if (input.files && input.files.length > 0) return importUploaded(input, input.files);
  if (!input.slug) return { ok: false, refusal: "not-found" };

  const [row] = await db
    .select({
      skillId: skills.id,
      slug: skills.slug,
      name: skills.name,
      status: skills.status,
      skillOrgId: skills.orgId,
      versionId: skillVersions.id,
      contentHash: skillVersions.contentHash,
      contentStored: skillVersions.contentStored,
      redistribution: skillVersions.redistribution,
      licenseSpdx: skillVersions.licenseSpdx,
      provenance: skillVersions.provenance,
      sourceUrl: sql<string | null>`(${skillVersions.provenance} ->> 'sourceUrl')`,
      markerPath: sql<string | null>`(${skillVersions.provenance} ->> 'path')`,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.id, skills.currentVersionId))
    .where(eq(skills.slug, input.slug))
    .limit(1);

  if (!row) return { ok: false, refusal: "not-found" };
  if (row.status === "withdrawn") return { ok: false, refusal: "withdrawn" };

  /*
   * Owned or forked, decided by the data rather than asked of the caller.
   *
   * A caller that could *declare* a skill its own would be a caller that could declare away the
   * licence gate below, which is the whole mechanism. The org id on the skill row is the fact.
   */
  const source: ImportSource = row.skillOrgId === input.orgId ? "owned" : "forked";

  if (source === "forked") {
    if (!isRedistributable(row.redistribution)) {
      return { ok: false, refusal: "not-redistributable" };
    }
    if (!row.contentStored) return { ok: false, refusal: "no-stored-bytes" };
  } else if (!row.contentStored) {
    return { ok: false, refusal: "no-stored-bytes" };
  }

  /* `BundleManifest.files` is a path → hash map, not a list of rows. */
  const manifest = await getManifest("public", row.contentHash);
  const paths = Object.keys(manifest?.files ?? {});
  if (paths.length === 0) return { ok: false, refusal: "empty" };

  const markerPath =
    row.markerPath && paths.includes(row.markerPath) ? row.markerPath : pickMarker(paths);
  if (!markerPath) return { ok: false, refusal: "empty" };

  const markerBytes = await getBundleFile("public", row.contentHash, markerPath);
  if (!markerBytes) return { ok: false, refusal: "empty" };

  const resources: DraftResource[] = [];
  for (const path of paths) {
    if (path === markerPath) continue;
    if (resources.length >= MAX_DRAFT_RESOURCES) break;
    const bytes = await getBundleFile("public", row.contentHash, path);
    if (!bytes) continue;
    /*
     * A binary asset is skipped rather than refused, and only here.
     *
     * On an upload the caller chose the files and deserves to be told; on a corpus bundle the
     * caller chose a skill and an image inside it is not their mistake. Dropping it silently
     * would be wrong too, so the count of what did not come across is reported by the caller.
     */
    if (looksBinary(bytes)) continue;
    if (bytes.byteLength > MAX_RESOURCE_BYTES) continue;
    const safe = safeResourcePath(path);
    if (!safe) continue;
    resources.push({ path: safe, content: bytes.toString("utf8"), byteSize: bytes.byteLength });
  }

  /*
   * Frozen, not joined. See `src/lib/improve.ts`: the obligation has to survive the upstream row
   * being deleted, which is the takedown module's own argument for duplicating its join columns.
   */
  const attribution: Attribution | null =
    source === "forked" && isRedistributable(row.redistribution)
      ? {
          slug: row.slug,
          name: row.name,
          sourceUrl: row.sourceUrl,
          licenseSpdx: row.licenseSpdx,
          posture: row.redistribution,
          importedAt: new Date().toISOString(),
        }
      : null;

  return createImportedDraft({
    orgId: input.orgId,
    userId: input.userId,
    name: input.name ?? row.name,
    category: input.category,
    domain: input.domain ?? null,
    marker: markerBytes.toString("utf8"),
    resources,
    source,
    upstreamVersionId: row.versionId,
    attribution,
  });
}

/**
 * The marker, when provenance does not name one.
 *
 * Same preference order the detector uses: a SKILL.md at the shallowest depth, then any marker
 * name. A bundle with two markers is a bundle whose detection was wrong, and picking the
 * shallowest is what the connector already does.
 */
function pickMarker(paths: readonly string[]): string | null {
  const markers = paths.filter((path) => /(^|\/)(SKILL\.md|AGENTS\.md|CLAUDE\.md)$/i.test(path));
  if (markers.length === 0) return paths.find((path) => path.endsWith(".md")) ?? null;
  return markers.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
}

async function importUploaded(input: ImportInput, files: UploadedFile[]): Promise<ImportResult> {
  if (files.length > MAX_DRAFT_RESOURCES + 1) return { ok: false, refusal: "too-many-files" };

  const decoded: Array<{ path: string; content: string; byteSize: number }> = [];
  for (const file of files) {
    const safe = safeResourcePath(file.path);
    if (!safe) return { ok: false, refusal: "not-found" };
    /* Refused rather than skipped, unlike a corpus bundle: the caller picked these. */
    if (looksBinary(file.bytes)) return { ok: false, refusal: "binary" };
    if (file.bytes.byteLength > MAX_RESOURCE_BYTES) return { ok: false, refusal: "file-too-large" };
    decoded.push({
      path: safe,
      content: new TextDecoder().decode(file.bytes),
      byteSize: file.bytes.byteLength,
    });
  }

  const markerPath = pickMarker(decoded.map((file) => file.path));
  const marker = decoded.find((file) => file.path === markerPath);
  if (!marker || marker.content.trim().length === 0) return { ok: false, refusal: "empty" };

  return createImportedDraft({
    orgId: input.orgId,
    userId: input.userId,
    name: input.name ?? marker.path.replace(/\.[^.]+$/, ""),
    category: input.category,
    domain: input.domain ?? null,
    marker: marker.content,
    resources: decoded.filter((file) => file.path !== markerPath),
    source: "uploaded",
    upstreamVersionId: null,
    /* Nothing is owed for a document the author says is theirs, and we cannot check it. */
    attribution: null,
  });
}

async function createImportedDraft(input: {
  orgId: string;
  userId: string;
  name: string;
  category: string;
  domain: string | null;
  marker: string;
  resources: DraftResource[];
  source: ImportSource;
  upstreamVersionId: string | null;
  attribution: Attribution | null;
}): Promise<ImportResult> {
  /* One definition of where a body starts, as everywhere else that reads a marker. */
  const { body, frontmatter } = splitFrontmatter(input.marker);
  if (body.trim().length === 0) return { ok: false, refusal: "empty" };

  const summary = typeof frontmatter.description === "string" ? frontmatter.description : null;

  const draftId = await withExplicitOrgScope(input.orgId, async (tx) => {
    const [row] = await tx
      .insert(skillDrafts)
      .values({
        orgId: input.orgId,
        createdBy: input.userId,
        name: input.name,
        slug: slugify(input.name),
        summary,
        archetypeCategory: input.category,
        domainCategory: input.domain,
        /*
         * The author's own words are empty on an import, and that is honest.
         *
         * `purpose` is what somebody typed into the builder; nobody typed anything here. Filling
         * it with the imported description would put the upstream author's words in this
         * author's mouth on the one field R6.2 reads as intent.
         */
        purpose: `Imported for revision (${input.source}).`,
        sectionInputs: {},
        scaffoldSections: [],
        frontmatter,
        /* Ready to edit: the document exists. It is not `collecting` and never was. */
        status: "ready",
        importSource: input.source,
        importedFromVersionId: input.upstreamVersionId,
        importAttribution: input.attribution,
      })
      .returning({ id: skillDrafts.id });

    if (input.resources.length > 0) {
      await tx.insert(draftResources).values(
        input.resources.map((resource) => ({
          orgId: input.orgId,
          draftId: row.id,
          path: resource.path,
          content: resource.content,
          byteSize: resource.byteSize,
        })),
      );
    }

    await tx.insert(events).values({
      orgId: input.orgId,
      actorType: "user",
      actorId: input.userId,
      kind: "draft.imported",
      subjectType: "skill_drafts",
      subjectId: row.id,
      payload: {
        source: input.source,
        resources: input.resources.length,
        upstreamVersionId: input.upstreamVersionId,
        licenseSpdx: input.attribution?.licenseSpdx ?? null,
      },
    });

    return row.id;
  });

  /*
   * The body goes through the same writer a generation uses, so it becomes typed blocks and
   * lands in the revision history with a reason. Outside the transaction because `setDraftBlocks`
   * opens its own scope — and safe to be, because a draft with no blocks is an empty draft rather
   * than a corrupt one.
   */
  await importDraftBody(draftId, input.orgId, body, { reason: "restored" });

  return { ok: true, draftId, source: input.source, resources: input.resources.length };
}

/* ------------------------------------------------------------- the bundle */

export async function listDraftResources(draftId: string, orgId: string) {
  return withExplicitOrgScope(orgId, async (tx) =>
    tx
      .select({
        id: draftResources.id,
        path: draftResources.path,
        content: draftResources.content,
        byteSize: draftResources.byteSize,
      })
      .from(draftResources)
      .where(eq(draftResources.draftId, draftId))
      .orderBy(asc(draftResources.path)),
  );
}

/** Create or replace one file. The upsert target is `(draft, path)`. */
export async function putDraftResource(
  draftId: string,
  orgId: string,
  path: string,
  content: string,
): Promise<{ ok: boolean; refusal?: ImportRefusal }> {
  const safe = safeResourcePath(path);
  if (!safe) return { ok: false, refusal: "not-found" };
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > MAX_RESOURCE_BYTES) return { ok: false, refusal: "file-too-large" };

  await withExplicitOrgScope(orgId, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(draftResources)
      .where(and(eq(draftResources.draftId, draftId), sql`${draftResources.path} <> ${safe}`));
    if (count >= MAX_DRAFT_RESOURCES) throw new Error("A draft holds a bundle, not a repository.");

    await tx
      .insert(draftResources)
      .values({ orgId, draftId, path: safe, content, byteSize })
      .onConflictDoUpdate({
        target: [draftResources.draftId, draftResources.path],
        set: { content, byteSize, updatedAt: new Date() },
      });
  });
  return { ok: true };
}

/**
 * RW.11's actuator: move one block into `references/` and leave a pointer (plan step C5).
 *
 * C5 computed this proposal and had nowhere to write it — a draft was one document, so there was
 * no `references/` to move anything into. `draft_resources` is that somewhere, which is why one
 * schema decision closed two steps.
 *
 * Two properties it must hold, and both fall out of going through `setDraftBlocks`:
 *
 * - **the body keeps its single writer.** The move is a block list, not a string edit.
 * - **it lands in the revision history**, so an author who dislikes the result restores forward
 *   rather than losing the text. That is the whole reason C1b made restore append.
 */
export async function offloadBlockToReference(
  draftId: string,
  orgId: string,
  blockId: string,
  fileName?: string,
): Promise<{ ok: boolean; path?: string; message?: string }> {
  const blocks = await getDraftBlocks(draftId, orgId);
  const target = blocks.find((block) => block.id === blockId);
  if (!target) return { ok: false, message: "No such block." };
  if (target.form === "heading") {
    return { ok: false, message: "A heading is the structure, not the detail under it." };
  }

  const path = safeResourcePath(
    `references/${slugify(fileName ?? target.type ?? "detail")}-${target.order}.md`,
  );
  if (!path) return { ok: false, message: "Could not name the file." };

  const written = await putDraftResource(draftId, orgId, path, `${target.text}\n`);
  if (!written.ok) return { ok: false, message: "The file is too large to move out." };

  /*
   * The pointer replaces the block in place, keeping its position.
   *
   * Appending it at the end would be the easier write and the wrong document: the reader arrives
   * at the place the detail used to be and finds nothing, then meets a pointer to it three
   * sections later. Progressive disclosure means a signpost where the turning is.
   */
  const next = blocks.map((block) =>
    block.id === blockId
      ? {
          id: block.id,
          form: block.form,
          depth: block.depth,
          type: "reference-pointer" as const,
          text: `See \`${path}\` for the detail.`,
        }
      : {
          id: block.id,
          form: block.form,
          depth: block.depth,
          type: block.type,
          text: block.text,
          rule: block.rule ?? null,
          sharedBlockId: block.sharedBlockId ?? null,
          sharedBlockVersion: block.sharedBlockVersion ?? null,
        },
  );

  await setDraftBlocks(draftId, orgId, next, { reason: "optimised" });
  return { ok: true, path };
}
