import "dotenv/config";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import { PLAN_FEATURES } from "../src/lib/plans";
import { RATE_LIMIT_DEFAULTS } from "../src/server/settings/rate-limits";

/**
 * An agent can create a draft and cannot publish one (Doc 2 RM.3, plan step F3).
 *
 *   pnpm verify:mcp-create
 *
 * Free. The stored half creates a real draft through the real function and removes it in a
 * `finally`.
 *
 * ## The property this file exists to protect
 *
 * **`create_skill` returns a draft and a URL. It never publishes.** Publishing runs the
 * validators, writes corpus rows and makes something downloadable — an agent doing that
 * unattended is one prompt away from putting a stranger's document into a workspace's registry.
 * The boundary is the same one B2 draws for public writes: recording and deciding are separate
 * actions, and a person does the second.
 *
 * That is asserted against the *source*, because it is a property of what the code can reach
 * rather than of what today's data happens to contain.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const create = strip(readFileSync(join(process.cwd(), "src/server/mcp/create.ts"), "utf8"));
const tools = strip(readFileSync(join(process.cwd(), "src/server/mcp/tools.ts"), "utf8"));

console.info("\nIt creates a draft, and cannot publish one");

check(
  "the creation path never reaches the publisher",
  !/publishDraft|applyPublish|storeBundle/.test(create),
  "publishing writes corpus rows and makes bytes downloadable; a person does that",
);
check(
  "and the tool says so in its own description",
  /never publishes/i.test(tools),
  "an agent reads the description to decide what will happen",
);
check(
  "the draft is written through the one block writer",
  /setDraftBlocks\(|importDraftBody\(/.test(create) && !/insert\(draftBlocks\)/.test(create),
  "so an MCP-created skill is typed blocks like every other draft — the reason F3 waited for C1",
);
/*
 * The same shape `verify:draft-blocks` uses, rather than a fresh regex.
 *
 * My first attempt matched any `body:` and flagged `body: written.body` — which passes the
 * rendered body *to* the validator and writes nothing. That is the fourth crude source scan in
 * this session. The property is specifically a `body` key inside a `.set(` or `.values(` on
 * `skillDrafts`, so that is what is matched, and the canonical scan in `verify:draft-blocks`
 * covers the whole tree anyway — this one is here because an importer holding a whole document
 * is the likeliest place for a second writer to appear.
 */
const writesBody = (source: string) =>
  (source.match(/\.(?:set|values)\(\{[\s\S]{0,2000}?\}\)/g) ?? []).some((call) =>
    /^\s*body:/m.test(call),
  );
check("and it never writes skill_drafts.body", !writesBody(create));

console.info("\nGated, and the refusal is something an agent can read");

check(
  "agent-side creation is Pro and above",
  !PLAN_FEATURES.free.includes("mcp-create-skill") &&
    PLAN_FEATURES.pro.includes("mcp-create-skill"),
);
check(
  "an unentitled caller gets a sentence, not a thrown error",
  /hasEntitlement\(/.test(tools) && !/requireEntitlement\(/.test(tools),
  "a JSON-RPC failure an agent cannot parse is a dead end; a sentence is something it can relay",
);
check(
  "the tool is registered for everyone, not hidden from the free tier",
  /registerWriteTools/.test(tools) && !/if \(!entitled\) return;/.test(tools),
  "a tool that vanishes teaches an agent the platform cannot do this at all",
);

console.info("\nWrites are limited in a different currency from reads");

check(
  "there is a dedicated write scope",
  Boolean(RATE_LIMIT_DEFAULTS.mcpWrite),
  `${RATE_LIMIT_DEFAULTS.mcpWrite.perMinute}/min · ${RATE_LIMIT_DEFAULTS.mcpWrite.perHour}/hr`,
);
check(
  "and it is far tighter than either read scope",
  RATE_LIMIT_DEFAULTS.mcpWrite.perHour < RATE_LIMIT_DEFAULTS.mcpFree.perHour &&
    RATE_LIMIT_DEFAULTS.mcpWrite.perHour < RATE_LIMIT_DEFAULTS.mcpPaid.perHour,
  "a read limit is loose because false refusals teach distrust; this bounds drafts a human must read",
);
check(
  "the write tool charges that scope, not the read one",
  /"mcpWrite"/.test(tools),
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the source checks above are complete");
}

if (connected) {
  const { rows: token } = await c.query<{ id: string; org_id: string; created_by: string | null }>(
    `select id, org_id, created_by from mcp_tokens limit 1`,
  );
  if (token.length === 0) {
    console.info("  skip  no MCP token to create against — make one at /account/mcp");
  } else {
    const { createSkillFromAgent } = await import("../src/server/mcp/create");
    let draftId: string | null = null;

    try {
      const refused = await createSkillFromAgent({
        tokenId: token[0].id,
        organizationId: token[0].org_id,
        name: "x",
        purpose: "too short a name",
        category: "review",
        body: "# Something",
      });
      check(
        "a name too short to identify anything is refused",
        !refused.ok,
        refused.ok ? "accepted" : refused.error,
      );

      const badCategory = await createSkillFromAgent({
        tokenId: token[0].id,
        organizationId: token[0].org_id,
        name: "verify mcp create probe",
        purpose: "probe",
        category: "not-a-category",
        body: "# Something",
      });
      check(
        "an invented category is refused and names the tool that lists the real ones",
        !badCategory.ok && badCategory.error.includes("list_archetypes"),
      );

      const created = await createSkillFromAgent({
        tokenId: token[0].id,
        organizationId: token[0].org_id,
        name: "verify mcp create probe",
        purpose: "A probe skill written by verify:mcp-create.",
        category: "review",
        blocks: [
          { heading: "When to use this", text: "Use it when running the verify suite." },
          { type: "guardrail", text: "Never run this against a production workspace." },
          { type: "not-a-block-type", text: "An unrecognised type is content, not an error." },
        ],
      });
      check("a well-formed call creates a draft", created.ok, created.ok ? created.url : created.error);
      if (!created.ok) throw new Error("cannot continue");
      draftId = created.draftId;

      check(
        "the blocks arrive typed, and an unknown type is kept as content",
        created.blocks === 4,
        `${created.blocks} blocks from 2 headings-and-texts plus one untyped`,
      );
      check(
        "the real validator ran and its findings came back",
        typeof created.quality === "number",
        `quality ${created.quality}/100, ${created.findings.length} finding(s)`,
      );

      const { rows: row } = await c.query<{
        org_id: string;
        created_by: string | null;
        status: string;
      }>(`select org_id, created_by, status from skill_drafts where id = $1`, [draftId]);
      check(
        "the draft belongs to the token's workspace",
        row[0].org_id === token[0].org_id,
      );
      check(
        "and is attributed to whoever created the token, or to nobody",
        row[0].created_by === token[0].created_by,
        row[0].created_by ?? "null — a principal carries no user, and created_by is a real key",
      );
      check(
        "it lands ready, not collecting — nobody filled in a form",
        row[0].status === "ready",
        row[0].status,
      );

      const { rows: published } = await c.query<{ n: string }>(
        `select count(*)::text as n from skills s
          join skill_drafts d on d.published_skill_id = s.id where d.id = $1`,
        [draftId],
      );
      check(
        "nothing was published",
        published[0].n === "0",
        "the boundary the whole design rests on",
      );
    } finally {
      if (draftId) await c.query(`delete from skill_drafts where id = $1`, [draftId]);
      const { rows: left } = await c.query<{ n: string }>(
        `select count(*)::text as n from skill_drafts where name = 'verify mcp create probe'`,
      );
      check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
