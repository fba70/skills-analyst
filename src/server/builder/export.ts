import "server-only";

import { zipSync, type Zippable } from "fflate";

import { sha256 } from "@/server/storage/keys";

import { EXPORT_DIALECTS, type DialectId } from "@/lib/dialects";
import { renderDialect } from "./dialects";
import { getDraft, type DraftDetail } from "./drafts";

/**
 * Exporting a draft to the tools people actually use (Doc 2 R4.4).
 *
 * One canonical draft, one archive, one directory per requested dialect. R4.4 asks for
 * "one canonical draft → export to selected platform dialects + zip bundle; every export
 * embeds provenance (created-by, archetype version, validation report hash)", and the
 * receipt below is that clause read literally.
 *
 * ## Byte-identical, for the same reason the corpus export is
 *
 * No `exportedAt`, and ZIP mtimes pinned to 1980-01-01 — the same two decisions
 * `skills/export.ts` had to make, for the same reason. A timestamp inside the archive means
 * two downloads of an unchanged draft differ, which destroys the one property a consumer
 * can actually check. The format cannot encode the epoch, hence 1980.
 *
 * ## Publishing is not this
 *
 * Export hands the author their bytes. Publishing (R6.1) puts the skill through the real
 * validation pipeline and into the corpus. They are separate on purpose: R4.5 lets an
 * author take an unvalidated copy for local use, and only blocks *publication*. An export
 * of a draft with blocking findings is allowed and says so in the receipt.
 */

const ZIP_EPOCH = new Date("1980-01-01T00:00:00Z");

export type DraftExport = {
  filename: string;
  bytes: Uint8Array;
  /** Hash of the archive's own content, so a caller can name what it handed over. */
  contentHash: string;
};

export type ExportRefusal = { ok: false; message: string };

export async function exportDraft(
  draftId: string,
  dialects: DialectId[],
): Promise<(DraftExport & { ok: true }) | ExportRefusal> {
  const draft = await getDraft(draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (!draft.body) return { ok: false, message: "Nothing to export — write the draft first." };

  const wanted = dialects.filter((d) =>
    EXPORT_DIALECTS.some((known) => known.id === d),
  );
  if (wanted.length === 0) return { ok: false, message: "Pick at least one format." };

  return { ok: true, ...buildDraftArchive(draft, wanted) };
}

/**
 * Split from `exportDraft` so the assembly can be tested without a session.
 *
 * The same division `skills/export.ts` makes between `buildBundle` and `exportSkill`: the
 * part with rules worth checking takes facts and returns bytes, and the part that looks
 * facts up through the DAL cannot load in a plain node script.
 */
export function buildDraftArchive(
  draft: Pick<
    DraftDetail,
    | "name"
    | "slug"
    | "summary"
    | "body"
    | "frontmatter"
    | "archetypeCategory"
    | "archetypeVersion"
    | "domainCategory"
    | "model"
    | "validation"
    | "qualityScore"
  >,
  dialects: DialectId[],
): DraftExport {
  const description = String(draft.frontmatter.description ?? draft.summary ?? "");
  const name = String(draft.frontmatter.name ?? draft.slug);
  const source = { name: draft.name, slug: name, description, body: draft.body ?? "" };

  const entries: Zippable = {};
  const rendered: Array<{ dialect: string; path: string; sha256: string }> = [];

  for (const dialect of dialects) {
    const file = renderDialect(source, dialect);
    // One directory per dialect: the same filename recurs across formats (SKILL.md and
    // AGENTS.md both sit at a project root), and a flat archive would collide or, worse,
    // silently overwrite.
    const path = `${draft.slug}/${dialect}/${file.path}`;
    entries[path] = new Uint8Array(file.content);
    rendered.push({ dialect, path, sha256: sha256(file.content) });
  }

  /**
   * The receipt R4.4 asks for, and one field it does not.
   *
   * `validationReportHash` covers the findings listed beside it, so a reader can tell
   * whether the copy they hold was checked and what was found. `blocked` is stated
   * outright rather than left to be inferred from severities: an export is allowed to carry
   * a failing draft (R4.5 only gates *publication*), and an archive that quietly looked
   * clean would be the dishonest version of that permission.
   */
  const findings = draft.validation?.findings ?? [];
  const reportHash = sha256(
    findings
      .map((f) => `${f.analyzer}:${f.reason}:${f.severity}`)
      .sort()
      .join("\n"),
  );

  const receipt = {
    tool: "Skills Foundry",
    kind: "draft-export",
    name: draft.name,
    slug: draft.slug,
    description,
    formats: rendered,
    archetype: {
      category: draft.archetypeCategory,
      version: draft.archetypeVersion,
    },
    domain: draft.domainCategory,
    generatedBy: draft.model,
    validation: {
      qualityScore: draft.qualityScore,
      blocked: draft.validation?.blocked ?? null,
      validationReportHash: reportHash,
      findings,
    },
    note:
      "Exported from a draft. It has not been published to a corpus and carries no upstream " +
      "provenance. validationReportHash covers the findings listed above.",
  };

  entries[`${draft.slug}/SKILL-FOUNDRY.json`] = new TextEncoder().encode(
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  const bytes = zipSync(entries, { level: 6, mtime: ZIP_EPOCH });

  return {
    filename: `${draft.slug}.zip`,
    bytes,
    contentHash: sha256(Buffer.from(bytes)),
  };
}
