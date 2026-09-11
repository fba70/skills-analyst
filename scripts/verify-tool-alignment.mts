import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { unzipSync } from "fflate";
import { Client } from "pg";

import {
  ALIGNMENT_FIXES,
  ALIGNMENT_KINDS,
  ALIGNMENT_META,
  alignTools,
  renderAllowedTools,
} from "../src/lib/alignment";
import { toolById } from "../src/lib/tools";

/**
 * Three sources, one agreement — and none of it a gate (Doc 7 RD.8, plan step P2).
 *
 *   pnpm verify:tool-alignment
 *
 * Free. The comparison half needs no database; the stored half writes a real draft through the
 * real functions and removes it in a `finally`.
 *
 * ## The three properties this file exists to protect
 *
 * 1. **Nothing here blocks a publish.** A draft naming `kubectl` with no guardrail is the
 *    loudest finding this module can produce, and it must still publish: a deployment skill
 *    that deletes things is doing its job, and a designer that refused it would convert advice
 *    into a prohibition nobody asked for. R4.5's analyzers are the gate and are not consulted.
 * 2. **The panel's promise is true.** It prints *this is what your export will carry*, so the
 *    report's line and the bytes `renderDialect` produces have to be the same string, produced
 *    by the same function. Two definitions of one sentence is how they start to disagree.
 * 3. **`allowed-tools` is Claude Code's key and leaves only through Claude Code's file.**
 *    AGENTS.md has no frontmatter by specification — the fact that once quarantined all 121 of
 *    them against the wrong contract — and a Cursor rule uses Cursor's keys.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary");

check(
  "every kind has its own sentence and a severity",
  new Set(Object.values(ALIGNMENT_META).map((m) => m.blurb)).size === ALIGNMENT_KINDS.length &&
    Object.values(ALIGNMENT_META).every((m) => m.severity === "act" || m.severity === "consider"),
  `${ALIGNMENT_KINDS.length} kinds`,
);
check(
  "doing nothing is an offered answer",
  (ALIGNMENT_FIXES as readonly string[]).includes("none"),
  "a broad allow-list may be deliberate, and a panel with a button for every row is a checklist",
);

console.info("\nNo list and an empty list are different facts");

const noList = alignTools({
  prose: ["kubectl"],
  declared: null,
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "a draft that declares nothing is not in disagreement with itself",
  !noList.findings.some((f) => f.kind === "undeclared"),
  "the author has not written a grant list; there is nothing yet to contradict",
);
check(
  "and the export line is offered instead",
  noList.proposedAllowedTools === "Bash(kubectl:*)",
  noList.proposedAllowedTools,
);

const emptyList = alignTools({
  prose: ["kubectl"],
  declared: [],
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "an empty list grants nothing, so the step is refused",
  emptyList.findings.some((f) => f.kind === "undeclared" && f.tool === "kubectl"),
  "`allowedToolsOf` returns [] for both, which is why the key is asked about rather than counted",
);

console.info("\nThe four disagreements");

const undeclared = alignTools({
  prose: ["kubectl", "agent:read"],
  declared: ["agent:read"],
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "a step that runs an ungranted tool is reported",
  undeclared.findings.some((f) => f.kind === "undeclared" && f.tool === "kubectl"),
);
check(
  "and a granted one is not",
  !undeclared.findings.some((f) => f.kind === "undeclared" && f.tool === "agent:read"),
);

const blanket = alignTools({
  prose: ["kubectl", "git", "jq"],
  declared: ["agent:bash"],
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "a blanket shell grant answers for every CLI, in one finding or none",
  blanket.findings.filter((f) => f.kind === "undeclared").length === 0,
  "three identical rows under one `Bash` grant is a panel an author learns to ignore",
);
check(
  "and that grant is not then reported as unused",
  !blanket.findings.some((f) => f.kind === "unused"),
);

const unused = alignTools({
  prose: [],
  declared: ["agent:webfetch"],
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "a grant nothing uses is reported, and nothing is changed for the author",
  unused.findings.some((f) => f.kind === "unused" && f.fix === "none"),
);

const reach = alignTools({
  prose: ["jq"],
  declared: null,
  bundleCapabilities: ["network", "fs_read"],
  hasGuardrail: true,
  hasResources: true,
});
check(
  "code that reaches further than the contracts say is reported",
  reach.findings.some((f) => f.kind === "undocumented-capability" && f.capability === "network"),
);
check(
  "but a capability a named tool already implies is not",
  !reach.findings.some((f) => f.capability === "fs_read"),
  "`jq` reads files; asking the author to also name the library their script imports is a checklist",
);

const destructive = alignTools({
  prose: ["git", "rm", "jq"],
  declared: null,
  bundleCapabilities: [],
  hasGuardrail: false,
  hasResources: false,
});
const unguarded = destructive.findings.filter((f) => f.kind === "unguarded-destructive");
check(
  "destructive tools with no guardrail produce one finding, not one each",
  unguarded.length === 1 && /git/.test(unguarded[0].message) && /rm/.test(unguarded[0].message),
  unguarded[0]?.message ?? "(none)",
);
check(
  "and none once a guardrail exists",
  !alignTools({ ...{ prose: ["git", "rm"], declared: null, bundleCapabilities: [], hasResources: false }, hasGuardrail: true }).findings.some(
    (f) => f.kind === "unguarded-destructive",
  ),
);
check(
  "a non-destructive tool never raises it",
  !alignTools({
    prose: ["jq", "cat"],
    declared: null,
    bundleCapabilities: [],
    hasGuardrail: false,
    hasResources: false,
  }).findings.some((f) => f.kind === "unguarded-destructive"),
  `${["jq", "cat"].filter((id) => toolById(id)?.destructive).length} of them are destructive`,
);

console.info("\nNothing to compare is not agreement");

const nothing = alignTools({
  prose: [],
  declared: null,
  bundleCapabilities: [],
  hasGuardrail: false,
  hasResources: false,
});
check(
  "a draft naming no tools and shipping no code is unmeasured, not clean",
  nothing.measured === false && nothing.findings.length === 0,
  "a green tick over this is the failure this codebase keeps paying for",
);
const clean = alignTools({
  prose: ["jq"],
  declared: ["jq"],
  bundleCapabilities: [],
  hasGuardrail: true,
  hasResources: false,
});
check(
  "and one that was compared and agrees is measured",
  clean.measured === true && clean.findings.length === 0,
);

console.info("\nThe generated grant");

check(
  "built-ins are written the way the harness spells them",
  renderAllowedTools(["agent:ask", "agent:webfetch"]) === "AskUserQuestion, WebFetch",
  renderAllowedTools(["agent:ask", "agent:webfetch"]),
);
check(
  "a CLI becomes a scoped Bash grant",
  renderAllowedTools(["git"]) === "Bash(git:*)",
);
check(
  "and no bare Bash is added beside it",
  !/(^|,\s)Bash(,|$)/.test(renderAllowedTools(["git", "kubectl"])),
  "a blanket shell grant is broader than the document asked for; widening it quietly is the opposite of the point",
);
check(
  "the line is deterministic and sorted",
  renderAllowedTools(["kubectl", "git", "agent:read"]) ===
    renderAllowedTools(["agent:read", "git", "kubectl"]),
  renderAllowedTools(["kubectl", "git", "agent:read"]),
);
check("nothing in, nothing out", renderAllowedTools([]) === "");

console.info("\nOne definition, and the dialects that must not carry it");

const dialects = readFileSync(join(process.cwd(), "src/server/builder/dialects.ts"), "utf8");
const agentsBlock = dialects.slice(dialects.indexOf('case "agents_md"'), dialects.indexOf('case "cursor_rule"'));
const cursorBlock = dialects.slice(dialects.indexOf('case "cursor_rule"'), dialects.indexOf('case "anthropic_skill"'));
check(
  "AGENTS.md carries no allowed-tools — it has no frontmatter at all",
  !/allowed-tools/.test(agentsBlock),
  "the contract that once quarantined all 121 AGENTS.md files in the corpus",
);
check(
  "nor does a Cursor rule, which uses Cursor's own keys",
  !/allowed-tools/.test(cursorBlock),
);
check(
  "the renderer never derives the grant itself",
  !/extractToolRefs|declaredOrDerivedTools/.test(dialects),
  "facts in, bytes out — deriving here would make publish emit it too",
);

const publish = readFileSync(join(process.cwd(), "src/server/builder/publish.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check(
  "publishing does not add the grant to the corpus",
  !/allowedTools/.test(publish),
  "a published skill's bytes are what a verdict covers; Doc 7 asks for the export",
);

/*
 * Comments stripped, because the first version of this check matched the module's own doc
 * comment explaining that the analysis is `server-only` — the sixth scanner in this codebase
 * to report the prose describing the rule instead of a breach of it.
 */
const align = readFileSync(join(process.cwd(), "src/lib/alignment.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check(
  "the comparison reaches no database, model or bundle",
  !/\bdb\b|generateText|loadBundle|server-only/.test(align),
  "a leaf, so every rule above runs with nothing configured",
);
check(
  "and the scan can see one",
  /server-only/.test(['import "server', '-only";'].join("")),
  "assembled at runtime, so the control is not a literal this very scan would report",
);

console.info("\nAgainst a real draft");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
  if (org.length === 0) {
    console.info("  skip  needs one organisation");
  } else {
    const orgId = org[0].id;
    const { alignmentForDraft, declaredOrDerivedTools } = await import(
      "../src/server/builder/alignment"
    );
    const { buildDraftArchive } = await import("../src/server/builder/export");
    const { getDraft } = await import("../src/server/builder/drafts");
    const { setDraftBlocks } = await import("../src/server/builder/blocks");

    let draftId: string | null = null;
    try {
      /*
       * Inserted directly, because `createDraft` resolves a session and there is none in a
       * script. Everything *after* this goes through the real functions — the same division
       * `verify:campaigns` makes, and the reason its publish probe means anything.
       */
      const { rows: made } = await c.query<{ id: string }>(
        `insert into skill_drafts (org_id, name, slug, purpose, archetype_category, status)
         values ($1, 'verify:tool-alignment probe', $2, 'probe', 'review', 'ready')
         returning id`,
        [orgId, `verify-tool-alignment-${Date.now()}`],
      );
      draftId = made[0].id;

      const block = (over: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        form: "content" as const,
        depth: null,
        type: null,
        text: "",
        rule: null,
        sharedBlockId: null,
        sharedBlockVersion: null,
        ...over,
      });

      /*
       * A draft that runs a destructive tool and states no constraint — the loudest finding
       * this module can produce, written as blocks because that is what a draft is.
       */
      await setDraftBlocks(
        draftId,
        orgId,
        [
          block({ form: "heading", depth: 2, text: "Steps" }),
          block({
            type: "tool-contract",
            text: "Run the rollout:\n\n```bash\nkubectl delete pod --all\ngit push --force\n```",
          }),
        ],
        { reason: "edited" },
      );

      const body = (await getDraft(draftId, orgId))?.body ?? "";
      const report = await alignmentForDraft(draftId, orgId);
      check("a draft can be aligned", report !== null);

      if (report) {
        check(
          "the tools its steps run are seen by the same extractor the corpus uses",
          report.prose.includes("kubectl") && report.prose.includes("git"),
          report.prose.join(" ") || "(none)",
        );
        check(
          "a destructive tool with no guardrail is marked",
          report.findings.some((f) => f.kind === "unguarded-destructive"),
          report.findings.map((f) => f.kind).join(", ") || "(none)",
        );
        check(
          "the draft declares no grant list, so nothing is reported as ungranted",
          report.declared === null && !report.findings.some((f) => f.kind === "undeclared"),
        );

        const draftFacts = {
          name: "verify:tool-alignment probe",
          slug: "verify-tool-alignment-probe",
          summary: "probe",
          body,
          frontmatter: {} as Record<string, unknown>,
          archetypeCategory: "review",
          archetypeVersion: null,
          domainCategory: null,
          model: null,
          validation: null,
          qualityScore: null,
        };
        /*
         * The real archive, unzipped — not `renderDialect` called again with a source this
         * script assembled. Rebuilding the source here would test my own reconstruction of
         * `buildDraftArchive` rather than what a download actually contains, which is the
         * shape of check that passes while the product is broken.
         */
        const archive = buildDraftArchive(draftFacts, ["anthropic_skill", "agents_md"]);
        const files = unzipSync(archive.bytes);
        const read = (suffix: string) => {
          const key = Object.keys(files).find((k) => k.endsWith(suffix));
          return key ? Buffer.from(files[key]).toString("utf8") : "";
        };

        /*
         * The promise the panel makes. Its line and the export's bytes are one string only
         * because both read `declaredOrDerivedTools`; two definitions of one sentence is how
         * they start to disagree.
         */
        check(
          "the SKILL.md export carries exactly the line the panel showed",
          read("SKILL.md").includes(`allowed-tools: ${report.proposedAllowedTools}`),
          report.proposedAllowedTools,
        );
        check("and the AGENTS.md export carries none", !read("AGENTS.md").includes("allowed-tools"));

        const again = buildDraftArchive(draftFacts, ["anthropic_skill", "agents_md"]);
        check(
          "two exports of one draft are byte-identical",
          archive.contentHash === again.contentHash,
          "R4.4's property, and a sorted grant is what keeps it",
        );
        check(
          "the panel and the export read one function",
          renderAllowedTools(declaredOrDerivedTools(body, {}).ids) === report.proposedAllowedTools,
        );
      }
    } finally {
      if (draftId) {
        await c.query(`delete from skill_drafts where id = $1`, [draftId]);
        const { rows: left } = await c.query<{ n: string }>(
          `select count(*)::text as n from skill_drafts where id = $1`,
          [draftId],
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
