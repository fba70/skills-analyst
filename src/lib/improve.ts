/**
 * Improve an existing skill (Doc 2 R5.6, plan step C6).
 *
 * ## The first step that serves somebody who did not author here
 *
 * Everything the builder does today starts from a blank draft and an archetype. R5.6 starts from
 * a document that already exists — *"point the assistant at an existing skill (owned or forked) →
 * archetype-gap analysis + guided revision"* — and once it is typed blocks, every surface the
 * Compose flow already has applies to it unchanged: block-level deviation marks (R4.3), the block
 * library (RW.3), the scope analyser and disclosure proposal (C5), the eval lab (D1).
 *
 * So this step is almost entirely **import**, and import is almost entirely **licence**.
 *
 * ## Three sources, and only one of them is free of the hard question
 *
 * - **owned** — a skill published from your own workspace. Nothing to ask: your bytes, your
 *   workspace, and re-publishing is a new version of your own work.
 * - **uploaded** — a document you hand us. Yours by assertion; we cannot check and do not
 *   pretend to. Recorded as an assertion rather than as a fact.
 * - **forked** — somebody else's skill from the public corpus. This is the one with teeth.
 *
 * ## A fork must not launder a licence, which is the same refusal the block library makes
 *
 * `block-library.ts` has no copy button, deliberately: pasting a stranger's paragraph into a
 * draft *"launders an attribution-required fragment into a document with no attribution"*. A fork
 * is that at whole-document scale, and the temptation is larger because the result looks like
 * ordinary authoring.
 *
 * Three rules carry it, and the third is the one that does the work:
 *
 * 1. **Only a redistributable posture may be forked at all.** `metadata_only` and `unresolved`
 *    have no stored bytes and no grant — the same gate the download route returns 451 for.
 * 2. **The obligation is frozen onto the draft**, not resolved by a join. `takedowns` duplicates
 *    `(source_url, skill_path)` out of its join columns for exactly this reason: the record has to
 *    work when the rows it was recorded against are gone, and a licence obligation that
 *    disappears because an upstream row was deleted is the failure mode with legal consequences.
 * 3. **Publishing a fork inherits the upstream posture, licence and licence source.** It does not
 *    become `authored` with a null licence, which is what the existing publish path would have
 *    written and would have been a lie. Inheriting is also what makes the obligation *work*:
 *    `exportSkill` already writes `ATTRIBUTION.txt` for an `attribution_required` posture, so the
 *    download path honours it with no new code — the requirement is satisfied by carrying a fact
 *    forward rather than by remembering to add a feature.
 *
 * The upstream *display* — its current name, whether it has since been withdrawn — still resolves
 * live, like an archetype exemplar. Frozen obligation, live presentation.
 */

/*
 * The redistributable set lives in `src/lib/licence.ts` and is re-exported here.
 *
 * It had grown three independent definitions before this step — `mayMirror` in storage, the block
 * library's `QUOTABLE`, and one written here — which is three copies of a rule about what may
 * legally be copied. One home, and every caller imports it.
 */
export {
  ATTRIBUTION_POSTURE,
  isRedistributable,
  REDISTRIBUTABLE,
  type RedistributablePosture,
} from "./licence";

import type { RedistributablePosture } from "./licence";

/** Where a draft's starting document came from. */
export const IMPORT_SOURCES = ["owned", "forked", "uploaded"] as const;

export type ImportSource = (typeof IMPORT_SOURCES)[number];

export function isImportSource(value: unknown): value is ImportSource {
  return typeof value === "string" && (IMPORT_SOURCES as readonly string[]).includes(value);
}

export const IMPORT_SOURCE_META: Record<ImportSource, { label: string; blurb: string }> = {
  owned: {
    label: "Your own skill",
    blurb: "Published from this workspace. Re-publishing makes a new version of your own work.",
  },
  forked: {
    label: "Forked from the registry",
    blurb:
      "Somebody else's skill, under a licence that permits copying. The attribution and the licence travel with the draft and with anything you publish from it.",
  },
  uploaded: {
    label: "Uploaded",
    blurb: "A document you provided. Recorded as your assertion, because we cannot check it.",
  },
};

/**
 * The obligation, frozen at import.
 *
 * Not resolved from the upstream row on read — see rule 2 above. Everything here is what a
 * downstream consumer is owed, and it has to survive the upstream skill being deleted, withdrawn
 * or re-synced under a different licence.
 */
export type Attribution = {
  /** The upstream skill's slug at import time. */
  slug: string;
  name: string;
  /** Where the bytes came from, for a human to follow. */
  sourceUrl: string | null;
  licenseSpdx: string | null;
  posture: RedistributablePosture;
  importedAt: string;
};

/**
 * The credit line, defined once.
 *
 * The draft page shows it, the publish path carries it, and `ATTRIBUTION.txt` is rendered from
 * the posture it sets. Two phrasings of one obligation is how a legal fact comes to differ
 * between two screens.
 */
export function attributionLine(attribution: Attribution): string {
  const licence = attribution.licenseSpdx ? ` under ${attribution.licenseSpdx}` : "";
  const origin = attribution.sourceUrl ? ` — ${attribution.sourceUrl}` : "";
  return `Derived from "${attribution.name}"${licence}${origin}`;
}

/**
 * Why an import was refused.
 *
 * Named, because each needs a different sentence and two of them are about the licence rather
 * than about the document — a reader told "import failed" would retry, and a reader told the
 * licence forbids copying knows to link out instead.
 */
export const IMPORT_REFUSALS = [
  "not-found",
  "not-redistributable",
  "no-stored-bytes",
  "withdrawn",
  "empty",
  "too-many-files",
  "file-too-large",
  "binary",
] as const;

export type ImportRefusal = (typeof IMPORT_REFUSALS)[number];

export const IMPORT_REFUSAL_MESSAGE: Record<ImportRefusal, string> = {
  "not-found": "No such skill.",
  "not-redistributable":
    "This skill's licence does not permit copying it. You can link to it, and the registry page stays readable, but it cannot be forked into a draft.",
  "no-stored-bytes":
    "We hold no copy of this skill's text — its licence did not permit keeping one — so there is nothing to import.",
  withdrawn: "This skill was withdrawn following a request and cannot be copied.",
  empty: "There is nothing in this document to import.",
  "too-many-files": "A draft holds a bundle, not a repository.",
  "file-too-large": "One of these files is larger than a draft may hold.",
  binary:
    "A draft holds text. Images and archives belong in the published bundle, not in the editor.",
};

/* ------------------------------------------------------------ draft bundles */

/**
 * How many files a draft may hold beside its marker.
 *
 * A skill bundle is a marker plus a handful of `references/` and `scripts/` files; the validator's
 * own backstop refuses a 300-file bundle because at that size detection has read a project as a
 * skill. This is far tighter, because a draft is an editing surface rather than a mirror.
 */
export const MAX_DRAFT_RESOURCES = 24;

/**
 * And how large each may be.
 *
 * Draft resources live in a `text` column rather than in object storage, which is the right trade
 * for kilobytes of markdown and shell: it keeps a draft entirely inside one org-scoped table with
 * one RLS policy, and avoids a storage lifecycle — orphaned objects, deletion on draft delete —
 * for data measured in kilobytes. The cap is what keeps that trade honest, and anything that
 * needs more than this is not an editing surface's problem.
 */
export const MAX_RESOURCE_BYTES = 128 * 1024;

/**
 * Text only, and the check is on the bytes rather than on the extension.
 *
 * An extension allow-list is a guess about a filename; a NUL byte is a fact about content. A
 * skill's bundled assets can legitimately be binary — the corpus has images — but they cannot be
 * *edited*, and holding them in a text column would corrupt them silently on the way through.
 * They are refused with a reason rather than dropped.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 8_000);
  for (const byte of window) if (byte === 0) return true;
  return false;
}

export type DraftResource = { path: string; content: string; byteSize: number };

/**
 * Paths a draft may hold, normalised.
 *
 * Refuses anything that climbs out of the bundle. The connector already declines to follow
 * symlinks out of a skill directory for the same reason — *"following arbitrary relative paths
 * out of a bundle is a directory-traversal problem we would be choosing to have"* — and an
 * uploaded archive is a far more direct way to try it than a git symlink.
 */
export function safeResourcePath(raw: string): string | null {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (path.length === 0 || path.length > 255) return null;
  if (path.startsWith("/") || path.includes("..") || path.includes("\0")) return null;
  if (/(^|\/)\.[^/]/.test(path)) return null;
  return path;
}
