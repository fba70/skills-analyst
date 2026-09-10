import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  allowedToolsOf,
  codeToolTokens,
  extractToolRefs,
  proseToolCandidates,
  SHELL_FENCE_LANGS,
  versionPinsOf,
} from "../src/lib/tool-refs";
import { EXTRACTOR_VERSION, extractStructure } from "../src/server/analytics/structure";

/**
 * Tool references are measured, not guessed (Doc 7 RD.6, plan step P0).
 *
 *   pnpm verify:tool-refs
 *
 * Free. The detector half calls no model, no network and no database; the stored half reads
 * `information_schema` and writes nothing.
 *
 * ## Written failure-first
 *
 * The naive reading of a shell fence — the first word of every line — puts `then`, `fi`, `done`
 * and the printed output of a `console` transcript at the top of the frequency table, and a
 * table headed by shell keywords is one nobody can write a vocabulary from. So the fixture is
 * built to make the naive reading fail, the suite asserts it *does* fail, and only then asserts
 * the real detector does not. A fixture the naive reading gets right proves nothing.
 *
 * The second property: **the columns are written.** The extractor can compute a field and the
 * writer can drop it on the way to the row — the failure this codebase hits most often — so the
 * suite reads `structure-run.ts` and requires all three columns in both the insert and the
 * upsert's `set`.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const FENCE = [
  "```bash",
  "# install and verify",
  "set -euo pipefail",
  "if [ -f package.json ]; then",
  "  pnpm install",
  "  FOO=bar sudo env time gh pr view 12 | jq .title",
  "else",
  "  echo nothing here",
  "fi",
  "./scripts/run.sh --dry",
  "python3 tools/gen.py \\",
  "  --out build/",
  "xargs rm -rf < list.txt",
  "```",
].join("\n");

console.info("\nThe naive reading, and why it is wrong");

const naive = FENCE.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
check(
  "the naive reading counts shell keywords and comments as tools",
  naive.includes("if") && naive.includes("else") && naive.includes("fi") && naive.includes("#"),
  "the trap is armed: this fixture makes the wrong answer available",
);
check(
  "and the fence delimiter, stripped of its backticks, reads as the tool `bash`",
  naive[0].replace(/^`+/, "") === "bash",
  "measured on the first real probe: 585 references across 131 skills, heading the table",
);
const tokens = codeToolTokens(FENCE, "bash");
check(
  "the detector does not",
  !tokens.some((t) => ["if", "then", "else", "fi", "set", "echo", "#"].includes(t)),
  tokens.join(" "),
);
check("and the fence line is not a command", !tokens.includes("bash"), "a block's text includes its own delimiters");
check(
  "wrappers and assignments are walked past to the real command",
  tokens.includes("gh") && !tokens.includes("sudo") && !tokens.includes("env") && !tokens.includes("time"),
  "FOO=bar sudo env time gh → gh",
);
check("a pipeline names every stage", tokens.includes("gh") && tokens.includes("jq"));
check("a bundled script is a token, with the ./ stripped", tokens.includes("scripts/run.sh"));
check(
  "a continuation line is not a new command",
  tokens.includes("python3") && !tokens.includes("--out"),
  "the backslash carries the command over",
);
check("xargs names itself and what it runs", tokens.includes("xargs") && tokens.includes("rm"));
check("pnpm survives", tokens.includes("pnpm"));

const heredoc = ["python3 - <<EOF", "import os", "def main():", "    print(1)", "EOF", "GET /api/users", "kubectl get pods"].join("\n");
const naiveHeredoc = heredoc.split("\n").map((l) => l.trim().split(/\s+/)[0].toLowerCase());
check(
  "naively, a heredoc body and an HTTP verb are commands",
  naiveHeredoc.includes("import") && naiveHeredoc.includes("def") && naiveHeredoc.includes("eof") && naiveHeredoc.includes("get"),
  "the second probe had eof, import, def and get in the code column",
);
const afterHeredoc = codeToolTokens(heredoc, "bash");
check(
  "a heredoc body is data, its terminator is not a command, and capitals are not either",
  afterHeredoc.join(" ") === "python3 kubectl",
  afterHeredoc.join(" "),
);

console.info("\nA transcript counts what was typed, not what was printed");

const transcript = ["$ kubectl get pods", "NAME    READY   STATUS", "web-1   1/1     Running", "$ helm list"].join("\n");
const naiveTranscript = transcript.split("\n").map((l) => l.split(/\s+/)[0]);
check(
  "naively, the output lines are tools too",
  naiveTranscript.includes("NAME") && naiveTranscript.includes("web-1"),
  "trap armed",
);
const typed = codeToolTokens(transcript, "console");
check(
  "with a prompt present, only prompted lines count",
  typed.length === 2 && typed.includes("kubectl") && typed.includes("helm"),
  typed.join(" "),
);
check(
  "a python fence yields nothing — its first token is import",
  codeToolTokens("import os\nos.system('rm -rf /')", "python").length === 0,
);
check(
  "an unlabelled fence yields nothing without a prompt",
  codeToolTokens("name: build\nrun: npm test", null).length === 0,
  "a YAML fence's first token is a key",
);
check(
  "but an unlabelled fence with a prompt is a shell",
  codeToolTokens("$ terraform plan", null).includes("terraform"),
);
check("the fence language list is shared with the block detector", SHELL_FENCE_LANGS.has("bash") && SHELL_FENCE_LANGS.has("console"));

console.info("\nProse: a mention confirms, it does not establish");

const prose =
  "Open the PR with `gh pr create`, then read `SKILL.md` and set `userId`. " +
  "Use `kubectl` for the cluster and `references/x.md` for detail.";
const candidates = proseToolCandidates(prose);
check(
  "every command-shaped inline span is a candidate",
  candidates.some((c) => c.token === "gh" && !c.multiToken) &&
    candidates.some((c) => c.token === "kubectl" && !c.multiToken),
  "`gh pr create` has no argument, so it is a candidate that needs confirming, like `kubectl`",
);
const confirmedNone = extractToolRefs({ frontmatter: {}, segments: [{ kind: "prose", language: null, text: prose }] });
check(
  "a multi-token span with an argument counts on its own",
  confirmedNone.counts.gh === undefined &&
    extractToolRefs({ frontmatter: {}, segments: [{ kind: "prose", language: null, text: "Run `gh pr view 12 --json title`." }] }).counts.gh === 1,
  "three bare words alone do not; a span carrying a flag does",
);
check(
  "an English phrase in backticks is not a command",
  extractToolRefs({ frontmatter: {}, segments: [{ kind: "prose", language: null, text: "It says `failed to fetch` or `the value`." }] }).refs.length === 0,
  "argv-shaped, and still a sentence",
);
check(
  "a single-token span does not, without a code sibling",
  confirmedNone.counts.kubectl === undefined && confirmedNone.counts["skill.md"] === undefined && confirmedNone.counts.userid === undefined,
  "`kubectl`, `SKILL.md` and `userId` are indistinguishable by shape",
);
const confirmed = extractToolRefs({
  frontmatter: {},
  segments: [
    { kind: "prose", language: null, text: prose },
    { kind: "code", language: "bash", text: "kubectl apply -f deploy.yaml" },
  ],
});
check(
  "and counts once the code names it",
  confirmed.counts.kubectl === 2,
  "one from the fence, one from the prose",
);
const snippets = extractToolRefs({
  frontmatter: {},
  segments: [
    {
      kind: "prose",
      language: null,
      text:
        "Send `POST /api/users`, then `const x = 1` and `import x from y`; check `where id = 1`, " +
        "`the value` and `await fetch()`. Finally `gh pr view 12 --json title`.",
    },
  ],
});
check(
  "a code snippet or an HTTP verb in backticks is not a command",
  ["post", "const", "import", "where", "the", "await"].every((t) => snippets.counts[t] === undefined),
  `${Object.keys(snippets.counts).join(" ") || "(nothing)"} — the first probe had post, get, const and await in its top sixty`,
);
check("while a span with an argument still is", snippets.counts.gh === 1);

console.info("\nFrontmatter: allowed-tools");

check(
  "the string form, with Bash specs",
  JSON.stringify(allowedToolsOf({ "allowed-tools": "Bash(git:*) Read Edit, Bash(npm run *)" })) ===
    JSON.stringify(["bash", "edit", "git", "npm", "read"]),
  allowedToolsOf({ "allowed-tools": "Bash(git:*) Read Edit, Bash(npm run *)" }).join(" "),
);
check(
  "the list form",
  allowedToolsOf({ allowedTools: ["Grep", "Bash(git commit:*, git push:*)"] }).join(" ") === "bash git grep",
);
check("an MCP tool names its server", allowedToolsOf({ tools: "mcp__github__create_issue" }).join(" ") === "mcp:github");
check("no key, no tools", allowedToolsOf({ name: "x" }).length === 0);
const withFm = extractToolRefs({
  frontmatter: { "allowed-tools": "Bash(gh:*)" },
  segments: [{ kind: "prose", language: null, text: "Use `gh` to open it." }],
});
check(
  "allowed-tools confirms a prose mention like code does",
  withFm.counts.gh === 2 && withFm.allowedTools.join(" ") === "bash gh",
);

console.info("\nVersion pins");

const PIN_TEXT =
  "This skill teaches Next.js 15 idioms. Requires node@20 and Python 3.11; terraform >= 1.5. " +
  "Step 3 comes after Phase 2. See chapter 4. Workflow 1 and Pattern 3 apply. Works on Node 18. " +
  "Then `sleep 5` and `return 1.0`; the score is 0.2 and all 3.0 of them pass. " +
  "But 4 remain. Have 5 minutes. Read 2 files first.";
const naivePins = [...PIN_TEXT.matchAll(/\b([A-Z][A-Za-z]+)\s+(\d{1,3})\b/g)].map((m) => m[1].toLowerCase());
check(
  "naively, every capitalised word before an integer is a version pin",
  naivePins.includes("workflow") && naivePins.includes("pattern") && naivePins.includes("node"),
  "the first probe's top pins were workflow 1, practices 1 and pattern 3 — numbered headings",
);
const unconfirmed = versionPinsOf(PIN_TEXT).map((p) => `${p.tool}@${p.version}`);
check(
  "next@15 (.js), node@20 (@), python@3.11 (dotted), terraform@1.5 (comparator) need no confirmation",
  ["next@15", "node@20", "python@3.11", "terraform@1.5"].every((k) => unconfirmed.includes(k)),
  unconfirmed.join(" "),
);
check(
  "a bare name and integer does not count unconfirmed — headings are not versions",
  !unconfirmed.some((k) => /^(workflow|pattern|step|phase|chapter|node)@(1|3|2|4|18)$/.test(k)),
  "Workflow 1, Pattern 3, Node 18 all dropped",
);
const confirmedPins = versionPinsOf(PIN_TEXT, new Set(["node", "read"])).map((p) => `${p.tool}@${p.version}`);
check(
  "but counts once the document invokes the tool",
  confirmedPins.includes("node@18") && !confirmedPins.includes("workflow@1"),
  "the same confirmation rule prose mentions live under",
);
check(
  "inline code and English with a number after it are not pins",
  !unconfirmed.some((k) => /^(sleep|return|is|all)@/.test(k)),
  "`sleep 5`, `return 1.0`, is 0.2, all 3.0 — the second probe's top pins",
);
check(
  "a capital at a sentence start is grammar, and a confirmed English-verb tool is not versioned",
  !confirmedPins.some((k) => /^(but|have|read)@/.test(k)) && confirmedPins.includes("python@3.11"),
  "But 4, Have 5, Read 2 — the third probe's pins; Python 3.11 mid-sentence stays",
);

console.info("\nThe extractor carries it, and the writer stores it");

check("extractor is 2.1.0 — the selector moved because the columns are new", EXTRACTOR_VERSION === "2.1.0");
const fp = extractStructure({
  files: [{ path: "SKILL.md", content: Buffer.from("") }],
  body: "# Deploy\n\nRun the plan first.\n\n```bash\nterraform plan\nterraform apply\n```\n",
  frontmatter: { name: "deploy", "allowed-tools": "Bash(terraform:*)" },
  markerPath: "SKILL.md",
});
check(
  "a fingerprint carries toolRefs, allowedTools and versionPins",
  fp.toolRefs.terraform === 3 && fp.allowedTools.join(" ") === "bash terraform" && Array.isArray(fp.versionPins),
  JSON.stringify(fp.toolRefs),
);
const empty = extractStructure({
  files: [{ path: "SKILL.md", content: Buffer.from("") }],
  body: "# Notes\n\nNothing runs here.\n",
  frontmatter: { name: "notes" },
  markerPath: "SKILL.md",
});
check(
  "a document with no tools reports an empty object, never undefined",
  JSON.stringify(empty.toolRefs) === "{}" && empty.allowedTools.length === 0 && empty.versionPins.length === 0,
  "so a `{}` row means looked and found nothing",
);

const run = readFileSync(join(process.cwd(), "src/server/analytics/structure-run.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
for (const column of ["toolRefs", "allowedTools", "versionPins"]) {
  const writes = run.match(new RegExp(`${column}:\\s*fingerprint\\.${column}`, "g"))?.length ?? 0;
  check(
    `${column} is written in the insert and in the upsert`,
    writes === 2,
    `${writes} write(s) — computed and dropped on the way out is the failure this codebase hits most`,
  );
}

console.info("\nStored columns");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows } = await c.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_name = 'skill_structures'
        and column_name in ('tool_refs','allowed_tools','version_pins')`,
  );
  if (rows.length === 0) {
    console.info("  skip  columns absent — the migration is not applied yet (pnpm db:migrate)");
  } else {
    check("all three columns exist", rows.length === 3, rows.map((r) => r.column_name).join(" "));
    check(
      "tool_refs and version_pins are jsonb, allowed_tools an array",
      rows.find((r) => r.column_name === "tool_refs")?.data_type === "jsonb" &&
        rows.find((r) => r.column_name === "version_pins")?.data_type === "jsonb" &&
        rows.find((r) => r.column_name === "allowed_tools")?.data_type === "ARRAY",
    );
    const { rows: stored } = await c.query<{ n: string }>(
      `select count(*)::text as n from skill_structures where extractor_version = $1 and tool_refs <> '{}'::jsonb`,
      [EXTRACTOR_VERSION],
    );
    if (stored[0].n === "0") {
      console.info(
        `  skip  nothing stored at ${EXTRACTOR_VERSION} yet — pnpm structures --extract 500 --drain fills it;` +
          ` pnpm structures --probe 300 --tools answers now`,
      );
    } else {
      check(`rows at ${EXTRACTOR_VERSION} carry tool references`, Number(stored[0].n) > 0, `${stored[0].n} rows`);
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
