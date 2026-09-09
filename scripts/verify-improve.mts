import "dotenv/config";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  attributionLine,
  IMPORT_REFUSAL_MESSAGE,
  IMPORT_REFUSALS,
  IMPORT_SOURCE_META,
  IMPORT_SOURCES,
  isImportSource,
  isRedistributable,
  looksBinary,
  MAX_DRAFT_RESOURCES,
  MAX_RESOURCE_BYTES,
  REDISTRIBUTABLE,
  safeResourcePath,
} from "../src/lib/improve";
import { ATTRIBUTION_POSTURE } from "../src/lib/licence";

/**
 * A fork carries its licence, and a draft keeps one body writer (Doc 2 R5.6, plan step C6).
 *
 *   pnpm verify:improve
 *
 * Free. The pure half needs no database; the stored half reads schema and policies and writes
 * nothing.
 *
 * ## The properties this file exists to protect
 *
 * 1. **Only a redistributable posture may be forked**, and the set has exactly one definition.
 *    It had grown three before this step, which is three copies of a rule about what may legally
 *    be copied — the kind of duplication no type checker reports and no reviewer notices.
 * 2. **Publishing a fork does not write `authored` over somebody else's licence.** That is the
 *    laundering the block library refuses a copy button over, at whole-document scale, and it is
 *    asserted against the *source* of `publish.ts` as well as against behaviour, because clean
 *    data proves nothing about the next edit.
 * 3. **The importer never writes `skill_drafts.body`.** An importer holding a whole document is
 *    the most tempting place in the codebase to add a second writer to the column C1 gave one.
 * 4. **A resource path cannot climb out of the bundle.** An uploaded archive is a far more
 *    direct way to try directory traversal than the git symlinks the connector already declines.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

console.info("\nOne definition of what may be copied");

check(
  "the redistributable set is exactly the two permissive postures",
  REDISTRIBUTABLE.length === 2 &&
    isRedistributable("mirror_allowed") &&
    isRedistributable(ATTRIBUTION_POSTURE),
  REDISTRIBUTABLE.join(", "),
);
check(
  "a licence we could not resolve is not permission",
  !isRedistributable("unresolved") && !isRedistributable("metadata_only"),
  "a missing answer must never read as a grant",
);

/*
 * The duplication this step removed, asserted so it cannot come back.
 *
 * `mayMirror` in storage and `QUOTABLE` in the block library each used to spell the pair out.
 * A fourth copy would be invisible to every other check in this repo, so the scan is on the
 * source: no file may write the two posture strings as an adjacent literal pair except the leaf
 * module that owns them.
 */
const roots = ["src", "scripts"].map((dir) => join(process.cwd(), dir));
const files = roots.flatMap((root) => sourceFiles(root));
/*
 * The scanner's first version was too crude, which is worth recording because it is the second
 * time in this repo a source scan has been.
 *
 * It matched any adjacent pair of the two posture strings — and flagged `POSTURE_KEYS` in the
 * licence badge and `POSTURES` in the MCP tool schema, which are the **four**-posture display
 * vocabulary and a completely different rule. Two of six hits were false, exactly as the
 * `= any(${array})` scanner's first version matched the warnings about the trap it hunts.
 *
 * A pair followed shortly by `metadata_only` is a full vocabulary, not a copy of the
 * redistributable set. It found four real ones the consolidation had missed.
 */
const literalPair = /["']mirror_allowed["']\s*,\s*["']attribution_required["'](?![\s\S]{0,60}metadata_only)/;
const offenders = files.filter((file) => {
  if (file.endsWith(join("src", "lib", "licence.ts"))) return false;
  if (file.endsWith(join("scripts", "verify-improve.mts"))) return false;
  return literalPair.test(readFileSync(file, "utf8"));
});
check(
  "no second copy of the redistributable pair exists in the tree",
  offenders.length === 0,
  offenders.map((f) => f.replace(process.cwd() + "/", "")).join(", ") || "one definition",
);
check(
  "and the scan can see files at all",
  files.length > 200,
  `${files.length} source files scanned`,
);

console.info("\nThe import vocabulary");

check(
  "three sources, each with its own label and blurb",
  IMPORT_SOURCES.length === 3 &&
    IMPORT_SOURCES.every((s) => IMPORT_SOURCE_META[s].label.length > 0) &&
    new Set(IMPORT_SOURCES.map((s) => IMPORT_SOURCE_META[s].blurb)).size === 3,
);
check("an unknown source is refused", !isImportSource("borrowed"));
check(
  "every refusal has its own sentence",
  new Set(IMPORT_REFUSALS.map((r) => IMPORT_REFUSAL_MESSAGE[r])).size === IMPORT_REFUSALS.length,
  `${IMPORT_REFUSALS.length} refusals`,
);
check(
  "the licence refusal tells the reader what they can still do",
  IMPORT_REFUSAL_MESSAGE["not-redistributable"].includes("link"),
  "a dead end invites a retry; a redirection does not",
);
check(
  "the credit line names the work, the licence and the origin",
  (() => {
    const line = attributionLine({
      slug: "x",
      name: "Terraform review",
      sourceUrl: "https://example.com/x",
      licenseSpdx: "Apache-2.0",
      posture: "attribution_required",
      importedAt: new Date().toISOString(),
    });
    return (
      line.includes("Terraform review") &&
      line.includes("Apache-2.0") &&
      line.includes("https://example.com/x")
    );
  })(),
);

console.info("\nA resource path cannot climb out of the bundle");

for (const bad of [
  "../secrets.md",
  "/etc/passwd",
  "references/../../x.md",
  ".env",
  "",
  "a\0b.md",
]) {
  check(`refused: ${JSON.stringify(bad)}`, safeResourcePath(bad) === null);
}
check("allowed: references/api.md", safeResourcePath("references/api.md") === "references/api.md");
check("normalised: ./scripts/run.sh", safeResourcePath("./scripts/run.sh") === "scripts/run.sh");
check(
  "backslashes are folded, so a Windows archive cannot smuggle a path",
  safeResourcePath("references\\api.md") === "references/api.md",
);

console.info("\nBinary is detected from the bytes, not from the name");

check(
  "a NUL byte is binary whatever the extension says",
  looksBinary(new Uint8Array([0x68, 0x69, 0x00, 0x21])),
);
check("plain text is not", !looksBinary(new TextEncoder().encode("# A skill\n\nSteps.")));
check(
  "the caps are small enough that a draft stays an editing surface",
  MAX_DRAFT_RESOURCES <= 32 && MAX_RESOURCE_BYTES <= 256 * 1024,
  `${MAX_DRAFT_RESOURCES} files, ${Math.round(MAX_RESOURCE_BYTES / 1024)} KiB each`,
);

console.info("\nPublishing a fork must not launder the licence");

const publishSource = readFileSync(join(process.cwd(), "src/server/builder/publish.ts"), "utf8");

/*
 * Asserted against the source, because the behaviour needs a forked draft and a real bundle to
 * observe and the failure is silent when it happens: a published fork with `licenseSource:
 * "authored"` looks exactly like an ordinary published draft. The three literals that used to be
 * unconditional are the whole bug, so the check is that none of them is unconditional any more.
 */
check(
  "the licence source is conditional on the import, not always `authored`",
  /licenseSource:\s*attribution\s*\?/.test(publishSource),
);
check(
  "the redistribution posture is inherited when there is one to inherit",
  /redistribution:\s*attribution\s*\?\s*attribution\.posture/.test(publishSource),
);
check(
  "the SPDX identifier travels with it",
  /licenseSpdx:\s*attribution\?\.licenseSpdx/.test(publishSource),
);
check(
  "the stored bundle carries the draft's own files, not just its marker",
  publishSource.includes("bundleFiles") && !/files:\s*\[file\],/.test(publishSource),
  "a bundle published as its marker alone silently drops what the archetype rewards most",
);

console.info("\nThe draft body still has exactly one writer");

/*
 * The same scan `verify:draft-blocks` runs, pointed at the module most likely to break it.
 *
 * An importer holds a whole document and a `body` column is right there. It writes blocks
 * through `importDraftBody` instead, and this is what stops that being quietly undone.
 */
const improveSource = readFileSync(join(process.cwd(), "src/server/builder/improve.ts"), "utf8");
check(
  "the importer never sets skill_drafts.body",
  !/\bbody\s*:/.test(improveSource.replace(/\/\*[\s\S]*?\*\//g, "")),
  "it goes through importDraftBody, the same path a generation takes",
);
check(
  "and it does go through the block writer",
  improveSource.includes("importDraftBody("),
);
check(
  "the RW.11 actuator writes blocks rather than editing a string",
  improveSource.includes("setDraftBlocks(") && improveSource.includes("reference-pointer"),
  "C5 computed this proposal and had nowhere to write it until draft_resources existed",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.draft_resources') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — apply the migration: pnpm db:migrate");
  } else {
    const { rows: policy } = await c.query<{ qual: string }>(
      `select qual from pg_policies where tablename = 'draft_resources'`,
    );
    check(
      "a draft's files are org-scoped with no public escape hatch",
      policy.length === 1 && !policy[0].qual.includes("is null"),
      "there is no such thing as a public draft, so there is no such thing as a public draft file",
    );

    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'skill_drafts'
        and column_name in ('import_source','imported_from_version_id','import_attribution')`,
    );
    check(
      "the draft carries its import provenance",
      columns.length === 3,
      columns.map((c) => c.column_name).join(", "),
    );

    const { rows: fk } = await c.query<{ delete_rule: string }>(
      `select rc.delete_rule
         from information_schema.referential_constraints rc
         join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
        where tc.table_name = 'skill_drafts'
          and tc.constraint_name like '%imported_from_version%'`,
    );
    check(
      "losing the upstream version nulls the pointer rather than deleting the draft",
      fk.length === 1 && fk[0].delete_rule === "SET NULL",
      fk[0]?.delete_rule ?? "no constraint",
    );

    /*
     * And the reason that is safe: the obligation does not live in the pointer.
     *
     * `import_attribution` is frozen jsonb, duplicated out of the join columns exactly as
     * `takedowns` duplicates `(source_url, skill_path)` — a licence obligation that disappears
     * because an upstream row was deleted is the failure mode with legal consequences.
     */
    check(
      "the obligation is a frozen column, not a join",
      columns.some((col) => col.column_name === "import_attribution"),
    );

    const { rows: forked } = await c.query<{ n: string }>(
      `select count(*)::text as n from skill_drafts where import_source = 'forked'`,
    );
    if (forked[0].n === "0") {
      console.info("  skip  nothing forked yet — import a registry skill from /build");
    } else {
      const { rows: bad } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_drafts
          where import_source = 'forked' and import_attribution is null`,
      );
      check(
        "every forked draft carries an attribution",
        bad[0].n === "0",
        "a fork with no obligation recorded is the laundering this step exists to prevent",
      );

      const { rows: published } = await c.query<{ n: string }>(
        `select count(*)::text as n
           from skill_drafts d
           join skills s on s.id = d.published_skill_id
           join skill_versions v on v.id = s.current_version_id
          where d.import_source = 'forked' and v.license_source = 'authored'`,
      );
      check(
        "no published fork claims to have been authored here",
        published[0].n === "0",
        `${published[0].n} laundered`,
      );
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
