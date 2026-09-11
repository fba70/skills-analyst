import "dotenv/config";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { CAPABILITY_META } from "../src/lib/capabilities";
import { FREE_FOREVER } from "../src/lib/plans";
import {
  destructiveAmong,
  resolveTool,
  resolveTools,
  TOOL_EVIDENCE,
  TOOL_EVIDENCE_META,
  TOOL_IDS,
  TOOL_KIND_META,
  TOOL_KINDS,
  toolById,
  toolLabel,
  TOOLS,
} from "../src/lib/tools";
import { EXTRACTOR_VERSION } from "../src/server/analytics/structure";

/**
 * The tool vocabulary is a closed list written from a count, and the relation is derived from it
 * (Doc 7 RD.6 / RD.7, plan step P1).
 *
 *   pnpm verify:tools
 *
 * Free. The pure half needs no database; the stored half reads three tables and writes nothing.
 *
 * ## The three properties this file exists to protect
 *
 * 1. **The list is the head of a distribution, not a description of one.** A vocabulary that
 *    named every token would be guessing, so the unrecognised share must stay above zero — the
 *    same line `verify:blocks` holds for unclassified passages, and for the same Doc 6 §7 reason.
 * 2. **Evidence decides between a built-in and a program.** `read`, `grep` and `bash` are both
 *    Claude Code tools and shell words, and resolving on the string alone would file 3,438
 *    `Read` declarations under a shell builtin nobody invokes.
 * 3. **The tool surface cannot be sold.** It is a decision surface of the same kind as the
 *    capability surface, so the entitlement gate must refuse the question.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

console.info("\nThe vocabulary");

check("every id is unique", new Set(TOOL_IDS).size === TOOL_IDS.length, `${TOOL_IDS.length} tools`);
check(
  "every tool has a label, a blurb and a known kind",
  TOOLS.every((t) => t.label.length > 0 && t.blurb.length > 0 && (TOOL_KINDS as readonly string[]).includes(t.kind)),
);
check(
  "every kind is used by at least one tool",
  TOOL_KINDS.every((kind) => TOOLS.some((t) => t.kind === kind)),
  "a kind nothing holds is a vocabulary describing a space that does not exist",
);
check(
  "every kind and every evidence has its own sentence",
  new Set(Object.values(TOOL_KIND_META).map((m) => m.blurb)).size === TOOL_KINDS.length &&
    new Set(Object.values(TOOL_EVIDENCE_META).map((m) => m.blurb)).size === TOOL_EVIDENCE.length,
);
check(
  "no alias collides with another tool's id or alias",
  (() => {
    const seen = new Set<string>();
    for (const tool of TOOLS) {
      for (const key of [tool.id, ...(tool.aliases ?? [])]) {
        const k = key.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
      }
    }
    return true;
  })(),
  "two entries claiming one token would resolve whichever way the list happens to be ordered",
);

/*
 * The capability list is duplicated as a type here so the module keeps no imports. That is the
 * standing hazard `section-roles.ts` carries and this is the check it lacks.
 */
check(
  "the capability keys match R2.4's, so the duplication cannot drift",
  TOOLS.every((t) => t.capabilities.every((cap) => cap in CAPABILITY_META)),
  Object.keys(CAPABILITY_META).join(" "),
);

console.info("\nDestructive is narrow, or it is an alarm nobody can silence");

const destructive = TOOLS.filter((t) => t.destructive);
check(
  "some tools are destructive",
  destructive.length > 0,
  destructive.map((t) => t.id).slice(0, 8).join(" ") + ` … ${destructive.length} of ${TOOLS.length}`,
);
check(
  "but a minority are",
  destructive.length / TOOLS.length < 0.5,
  `${Math.round((destructive.length / TOOLS.length) * 100)}% — RD.8 reads this to accuse a draft, and a flag true of everything fires everywhere`,
);
check(
  "the ones that delete, mutate production or run code elsewhere are",
  ["rm", "git", "kubectl", "terraform", "psql", "ssh", "aws"].every((id) => toolById(id)?.destructive === true),
);
check(
  "and reading, searching or installing is not",
  ["grep", "jq", "curl", "npm", "pip", "cat", "find"].every((id) => toolById(id)?.destructive === false),
  "installing a package is not destructive; deleting a cluster is",
);
check(
  "destructiveAmong is the only reader of the flag",
  destructiveAmong(["grep", "rm", "jq"]).join(" ") === "rm",
);

console.info("\nEvidence decides between a built-in and a program");

check(
  "`read` from frontmatter is the harness tool",
  resolveTool("Read", "frontmatter") === "agent:read",
  "3,438 skills declare it; none of them mean the shell word",
);
check(
  "`grep` from frontmatter is the harness tool, and from a command line the program",
  resolveTool("Grep", "frontmatter") === "agent:grep" && resolveTool("grep", "code") === "grep",
);
check(
  "`bash` likewise",
  resolveTool("Bash", "frontmatter") === "agent:bash" && resolveTool("bash", "code") === "bash",
);
check(
  "a token nothing names resolves to null rather than to something near it",
  resolveTool("frobnicate", "code") === null && resolveTool("const", "code") === null,
  "null is a normal answer and is counted, never dropped",
);
check("aliases resolve", resolveTool("python3", "code") === "python" && resolveTool("apt-get", "code") === "apt");
check("and are case-insensitive", resolveTool("GH", "code") === "gh", "the repository-identity fold, one layer up");
check(
  "`allowed-tools` spelling of the question tool resolves",
  resolveTool("AskUserQuestion", "frontmatter") === "agent:ask",
);

console.info("\nResolution keeps the strongest evidence and counts what it could not name");

const resolved = resolveTools([
  { token: "Read", evidence: "frontmatter" },
  { token: "git", evidence: "code" },
  { token: "git", evidence: "prose" },
  { token: "kubectl", evidence: "prose" },
  { token: "frobnicate", evidence: "code" },
  { token: "wibble", evidence: "code" },
]);
check(
  "one row per tool, not per reference",
  resolved.tools.length === 3,
  resolved.tools.map((t) => `${t.id}:${t.evidence}`).join(" "),
);
check(
  "declared beats invoked beats mentioned",
  resolved.tools.find((t) => t.id === "git")?.evidence === "code" &&
    resolved.tools.find((t) => t.id === "kubectl")?.evidence === "prose",
);
check(
  "and what nothing named is returned rather than swallowed",
  resolved.unrecognised.join(" ") === "frobnicate wibble",
  "the share of these is the measure of whether the list is complete enough",
);

console.info("\nThe tool surface cannot be sold");

check(
  "tool-surface is free for ever",
  (FREE_FOREVER as readonly string[]).includes("tool-surface"),
  "which tools a skill will run is a decision surface; charging for it sells the warning",
);

console.info("\nOne definition, read by every surface");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const stack = [join(process.cwd(), dir)];
  while (stack.length > 0) {
    const here = stack.pop() as string;
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const full = join(here, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") stack.push(full);
      } else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(full);
    }
  }
  return out;
}

const tree = [...filesUnder("src"), ...filesUnder("scripts")];

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** A second hand-written list of tool ids is the drift this vocabulary exists to prevent. */
const SECOND_LIST = /["'](?:kubectl|terraform)["'][\s,]+["'](?:helm|kubectl|aws)["']/;
const offenders = tree
  .filter((file) => !/src\/lib\/tools\.ts$/.test(file))
  .filter((file) => SECOND_LIST.test(strip(readFileSync(file, "utf8"))));
check(
  "no second list of tool ids anywhere in the tree",
  offenders.length === 0,
  offenders.length === 0 ? "one copy" : offenders.map((f) => f.replace(process.cwd() + "/", "")).join(", "),
);
/*
 * The control is **assembled at runtime**, and that is not fussiness.
 *
 * Written as a literal it sits in this file, the scan reads this file, and the suite reports
 * itself as the offender — which is exactly what the first version did. Five scanners in this
 * codebase have now matched their own prose or their own fixture: `verify:relations` hunting
 * `= any(${array})`, `verify:improve` hunting duplicate licence lists, `verify:mcp-usage`, the
 * `no-db-in-api` hook, and `verify:parameters` reading `shared_block_id` as a stored share.
 * A scanner shouts loudest where the problem is least.
 */
check(
  "the scan could find one",
  SECOND_LIST.test(`const x = [${'"kubectl",'} ${'"helm"'}];`),
  "a scan that matches nothing passes for the wrong reason",
);

/*
 * And one *count*, for the same reason. There were briefly two — an unscoped one in
 * `tool-index.ts` pinning `org_id is null`, and the scoped one beside the other facets — so a
 * signed-in visitor would have seen their own workspace's skills in the filtered list and
 * missing from the number beside it. The DAL's is the survivor and `/tools` reads it too.
 */
const counters = tree.filter((file) => {
  const body = strip(readFileSync(file, "utf8"));
  return /groupBy\(\s*skillTools\.tool\s*\)/.test(body);
});
check(
  "exactly one function counts skills per tool",
  counters.length === 1 && /src\/server\/dal\/skills\.ts$/.test(counters[0] ?? ""),
  counters.map((f) => f.replace(process.cwd() + "/", "")).join(", ") || "none found",
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
    `select to_regclass('public.skill_tools') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  skill_tools absent — run pnpm db:generate, read the SQL, then pnpm db:migrate");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'skill_tools'`,
    );
    check(
      "no column could hold body text",
      !columns.some((col) => /text|body|excerpt|snippet|content/.test(col.column_name)),
      "a tool row is an id and an evidence kind; asserted against the schema, not today's data",
    );
    check(
      "the facet's query has an index to use",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes where tablename = 'skill_tools' and indexdef ilike '%extractor_version%tool%'`,
        )
      ).rows[0].n !== "0",
    );
    check(
      "one row per version per tool",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes where tablename = 'skill_tools' and indexdef ilike '%unique%' and indexdef ilike '%skill_version_id%'`,
        )
      ).rows[0].n !== "0",
    );
    check(
      "tenant isolation is declared on the table",
      (
        await c.query<{ n: string }>(`select count(*)::text as n from pg_policies where tablename = 'skill_tools'`)
      ).rows[0].n !== "0",
    );

    /*
     * The loop this step shipped and ran 776 times.
     *
     * Resolution used to be keyed on *no `skill_tools` rows exist for this version*. But a
     * version naming no recognised tool legitimately produces none, so it stayed selectable
     * for ever: each pass took the same 2,000, wrote nothing, and `remaining` never moved.
     * The count below is exactly how many versions the old selector would re-select on every
     * pass — a number, not a description, and the reason `tools_resolved_at` exists.
     */
    const { rows: marker } = await c.query<{ present: boolean }>(
      `select exists (select 1 from information_schema.columns
                       where table_name = 'skill_structures' and column_name = 'tools_resolved_at') as present`,
    );
    check(
      "looked-and-found-nothing is recordable",
      marker[0].present,
      "absence of rows cannot mean 'not done' when absence is also the answer",
    );
    if (marker[0].present) {
      const { rows: trap } = await c.query<{ examined: string; empty: string; pending: string }>(
        `select count(*) filter (where s.tools_resolved_at is not null)::text as examined,
                count(*) filter (where s.tools_resolved_at is not null and not exists (
                  select 1 from skill_tools t
                   where t.skill_version_id = s.skill_version_id and t.extractor_version = s.extractor_version
                ))::text as empty,
                count(*) filter (where s.tools_resolved_at is null)::text as pending
           from skill_structures s where s.extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      if (trap[0].examined === "0") {
        console.info("  skip  nothing resolved yet — run pnpm structures --resolve-tools --drain");
      } else {
        check(
          "versions the vocabulary names nothing in are marked done, not left pending",
          Number(trap[0].empty) > 0,
          `${trap[0].empty} examined and empty — the old selector re-read exactly these, for ever`,
        );
        check(
          "and the queue can reach zero",
          trap[0].pending === "0",
          `${trap[0].pending} pending of ${Number(trap[0].examined) + Number(trap[0].pending)}`,
        );
      }
    }

    const { rows: stored } = await c.query<{ n: string }>(
      `select count(*)::text as n from skill_tools where extractor_version = $1`,
      [EXTRACTOR_VERSION],
    );
    if (stored[0].n === "0") {
      console.info(
        `  skip  nothing resolved at ${EXTRACTOR_VERSION} yet — run pnpm structures --resolve-tools --drain`,
      );
    } else {
      check(`rows exist at ${EXTRACTOR_VERSION}`, Number(stored[0].n) > 0, `${stored[0].n} rows`);

      const { rows: vocab } = await c.query<{ tool: string }>(
        `select distinct tool from skill_tools where extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      check(
        "every stored tool is in the vocabulary",
        vocab.every((r) => (TOOL_IDS as readonly string[]).includes(r.tool)),
        vocab.filter((r) => !(TOOL_IDS as readonly string[]).includes(r.tool)).map((r) => r.tool).join(" ") || `${vocab.length} distinct`,
      );
      const { rows: ev } = await c.query<{ evidence: string }>(
        `select distinct evidence from skill_tools where extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      check(
        "every stored evidence kind is in the vocabulary",
        ev.every((r) => (TOOL_EVIDENCE as readonly string[]).includes(r.evidence)),
        ev.map((r) => r.evidence).join(" "),
      );

      /*
       * The headline. A vocabulary that named every token would be guessing rather than
       * recognising, so this number has to stay above zero — and it is also what says whether
       * the list is worth filtering on at all.
       */
      const { rows: tokens } = await c.query<{ token: string }>(
        `select distinct t.key as token from skill_structures s, jsonb_each(s.tool_refs) t where s.extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      const named = tokens.filter(
        (t) => resolveTool(t.token, "code") !== null || resolveTool(t.token, "frontmatter") !== null,
      ).length;
      const share = tokens.length > 0 ? ((tokens.length - named) / tokens.length) * 100 : 0;

      /*
       * Both denominators, and the reference one leads.
       *
       * The distinct-token share alone is 98.7% unrecognised, which reads as a failed
       * vocabulary and is not what is happening: the tail is 9,316 strings each appearing
       * once or twice, while the 126 entries that do resolve carry most of the traffic. A
       * rate whose denominator answers a different question from the one being asked is the
       * label-*share*-against-labels-per-skill mistake, and that one inverted a conclusion.
       */
      const { rows: refShare } = await c.query<{ total: string; named: string }>(
        `select sum((t.value)::int)::text as total,
                sum(case when lower(t.key) = any($2::text[]) then (t.value)::int else 0 end)::text as named
           from skill_structures s, jsonb_each_text(s.tool_refs) t
          where s.extractor_version = $1`,
        [
          EXTRACTOR_VERSION,
          tokens
            .map((t) => t.token)
            .filter(
              (token) =>
                resolveTool(token, "code") !== null || resolveTool(token, "frontmatter") !== null,
            )
            .map((t) => t.toLowerCase()),
        ],
      );
      const refPct = (Number(refShare[0].named) / Number(refShare[0].total)) * 100;
      check(
        "the vocabulary resolves most references",
        refPct > 50,
        `${refPct.toFixed(1)}% of ${refShare[0].total} references — the number a reader experiences`,
      );
      check(
        "and the unrecognised tail is real",
        tokens.length > 0 && named < tokens.length,
        `${named} of ${tokens.length} distinct tokens named · ${share.toFixed(1)}% of *tokens* unrecognised,` +
          ` which is the long tail and is meant to stay`,
      );
      /*
       * Every entry earns its place, and this is the check that keeps the list honest as it
       * grows. An id nothing in the corpus references was not written from the table — it was
       * remembered, which is the failure `seeds.ts` documents after three of its hand-written
       * entries turned out to be 404s. Measured 103 of 103 on the first resolution.
       */
      const { rows: used } = await c.query<{ tool: string }>(
        `select distinct tool from skill_tools where extractor_version = $1`,
        [EXTRACTOR_VERSION],
      );
      const seen = new Set(used.map((r) => r.tool));
      const unused = TOOL_IDS.filter((id) => !seen.has(id));
      check(
        "every entry in the vocabulary is referenced by at least one skill",
        unused.length === 0,
        unused.length === 0
          ? `${TOOL_IDS.length} of ${TOOL_IDS.length} earn their place`
          : `${unused.join(" ")} — written from memory rather than from the table`,
      );

      const { rows: top } = await c.query<{ tool: string; skills: string }>(
        `select t.tool, count(distinct t.skill_id)::text as skills
           from skill_tools t join skills s on s.id = t.skill_id
          where t.extractor_version = $1 and s.status = 'indexed' and s.org_id is null
            and s.canonical_skill_id is null and s.current_version_id = t.skill_version_id
          group by t.tool order by count(distinct t.skill_id) desc limit 12`,
        [EXTRACTOR_VERSION],
      );
      console.info("\n  the facet, as a reader would see it");
      for (const row of top) console.info(`    ${toolLabel(row.tool).padEnd(22)} ${row.skills.padStart(6)}`);
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
