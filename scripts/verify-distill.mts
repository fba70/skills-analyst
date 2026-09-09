import "dotenv/config";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CORRECTION_CUES,
  correctionWindows,
  MAX_WINDOWS_PER_RUN,
  parseTranscript,
  REDACTED,
  redact,
  TRANSCRIPT_ROLES,
  type TranscriptTurn,
} from "../src/lib/distill";

/**
 * Distill mode reads a person, not their filesystem (Doc 6 RW.5, plan step C4).
 *
 *   pnpm verify:distill
 *
 * Free, and needs no database and no network. The parser is pure, which is the point: the rule
 * this file exists to protect is about *which rows count as somebody speaking*, and that can be
 * asserted against a hand-built transcript with the exact shapes that matter.
 *
 * ## The property that shapes the whole step
 *
 * A Claude Code transcript feeds every tool result back as a `user` message. Measured across
 * three real transcripts: **645 of 685 `user` rows carry tool output and 40 carry human speech.**
 * A parser that kept every `user` row would attribute the contents of every file read during the
 * session to the author, as things they said — and then send them to a model.
 *
 * So the suite reproduces that first: it builds a transcript where the naive reading yields file
 * contents as a human turn, asserts the naive reading *would* pick it up, and then asserts the
 * real parser does not. A check that cannot observe the failure is not evidence.
 *
 * If a real transcript is present on this machine the suite also parses it, because a synthetic
 * fixture proves the rule and only a real file proves the rule matches reality.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const line = (row: unknown) => `${JSON.stringify(row)}\n`;

/* A transcript with one human turn and one tool result, both typed `user`. */
const SECRET_IN_TOOL_OUTPUT = "DATABASE_URL=postgres://admin:hunter2@db.internal/prod";
const fixture =
  line({ type: "mode", mode: "default" }) +
  line({ type: "user", uuid: "u1", timestamp: "2026-09-09T10:00:00Z", message: { role: "user", content: "Always run the dry run first." } }) +
  line({
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the user seems to want a dry run" },
        { type: "text", text: "Understood — dry run first." },
        { type: "tool_use", name: "Bash", input: { command: "cat .env" } },
      ],
    },
  }) +
  line({
    type: "user",
    uuid: "u2",
    message: { role: "user", content: [{ type: "tool_result", content: SECRET_IN_TOOL_OUTPUT }] },
  }) +
  line({ type: "file-history-snapshot", snapshot: {} }) +
  "{ this line is not json\n";

console.info("\nTool output is not somebody speaking");

/*
 * The naive reading, reproduced before the fix is asserted.
 *
 * "Keep every row whose type is user or assistant" is the obvious parser and it is the bug: it
 * lifts the contents of `.env` out of a tool result and calls it a human turn.
 */
const naive = fixture
  .split("\n")
  .filter((l) => l.trim())
  .flatMap((l) => {
    try {
      return [JSON.parse(l) as { type?: string; message?: { content?: unknown } }];
    } catch {
      return [];
    }
  })
  .filter((row) => row.type === "user")
  .map((row) => JSON.stringify(row.message?.content ?? ""));
check(
  "the naive reading really does pick up the tool output",
  naive.some((text) => text.includes("hunter2")),
  "so the fixture still reproduces the bug",
);

const report = parseTranscript(fixture);
check(
  "the parser does not",
  !report.turns.some((turn) => turn.text.includes("hunter2")),
  `${report.toolResults} tool result(s) dropped`,
);
check(
  "the human turn survives",
  report.turns.filter((t) => t.role === "human").length === 1 &&
    report.turns[0].text === "Always run the dry run first.",
);
check(
  "the assistant's prose survives and its reasoning does not",
  report.turns.some((t) => t.role === "assistant" && t.text.includes("dry run first")) &&
    !report.turns.some((t) => t.text.includes("the user seems to want")),
  `${report.thinking} thinking block(s) dropped`,
);
check(
  "tool_use arguments never become text",
  !report.turns.some((turn) => turn.text.includes("cat .env")),
  "a tool call carries file paths, commands and sometimes credentials",
);
check(
  "housekeeping rows are counted, not kept",
  report.housekeeping === 2,
  `${report.housekeeping} rows: mode, file-history-snapshot`,
);
check(
  "a truncated last line does not cost the file",
  report.malformed === 1 && report.turns.length > 0,
  "a transcript is an append-only log and can be cut mid-write",
);
check(
  "every kept turn carries its provenance",
  report.turns.every((turn) => turn.uuid !== null),
  "a uuid into a file only the author holds — we never store the transcript",
);
check("there are exactly two roles", TRANSCRIPT_ROLES.length === 2);

console.info("\nRedaction runs before anything reaches a model");

const redacted = redact("my key is sk-abcdefghijklmnopqrstuvwx and token: swordfish");
check(
  "an API key and a labelled token are both removed",
  !redacted.text.includes("sk-abcdefghij") && !redacted.text.includes("swordfish"),
  `${redacted.hits} hit(s)`,
);
check("the replacement is visible, not silent", redacted.text.includes(REDACTED));
check(
  "a URL with inline credentials is caught",
  redact("see postgres://user:pw@host/db").text.includes(REDACTED),
);
check(
  "ordinary prose is untouched",
  redact("Always run the dry run first, never skip it.").hits === 0,
  "over-redaction costs a candidate block; under-redaction sends a credential to a third party",
);

console.info("\nOnly corrections are worth a model call");

const turns: TranscriptTurn[] = [
  { role: "human", text: "Write a deploy skill.", uuid: "1", at: null, index: 0 },
  { role: "assistant", text: "Here is a draft.", uuid: "2", at: null, index: 1 },
  { role: "human", text: "No, we never deploy on a Friday.", uuid: "3", at: null, index: 2 },
  { role: "assistant", text: "Adjusted.", uuid: "4", at: null, index: 3 },
  { role: "human", text: "Thanks.", uuid: "5", at: null, index: 4 },
];
const windows = correctionWindows(turns);
check(
  "a correction is selected and an ordinary turn is not",
  windows.length === 1 && windows[0].at === 2,
  `${windows.length} window(s) from ${turns.length} turns`,
);
check(
  "the window carries context, because a correction alone is unusable",
  windows[0].turns.length > 1,
  `${windows[0].turns.length} turns — "no, the other one" means nothing by itself`,
);
check(
  "cues match whole words",
  !CORRECTION_CUES.some((cue) => cue.test("cannot reproduce the notation")),
  "a substring match would fire `not` inside `cannot` and `notation`",
);
check(
  "an assistant turn cannot raise a correction",
  correctionWindows([
    { role: "assistant", text: "No, that is wrong.", uuid: "1", at: null, index: 0 },
  ]).length === 0,
  "the knowledge being captured is the author's, not the model's",
);
check(
  "there is a fuse on how many windows one run sends",
  MAX_WINDOWS_PER_RUN > 0 && MAX_WINDOWS_PER_RUN <= 100,
  `${MAX_WINDOWS_PER_RUN} — a long session can carry a hundred corrections`,
);

console.info("\nAgainst a real transcript, if this machine has one");

/*
 * A synthetic fixture proves the rule; only a real file proves the rule matches reality.
 *
 * Skipped cleanly rather than failed when there is none — this is somebody's local Claude Code
 * history and a suite that required it would be a suite that only ever runs on one laptop.
 */
const projects = join(homedir(), ".claude", "projects");
const found: string[] = [];
if (existsSync(projects)) {
  for (const dir of readdirSync(projects)) {
    const full = join(projects, dir);
    try {
      for (const file of readdirSync(full)) {
        if (file.endsWith(".jsonl")) found.push(join(full, file));
      }
    } catch {
      /* unreadable project directory — not this suite's problem */
    }
    if (found.length >= 3) break;
  }
}

if (found.length === 0) {
  console.info("  skip  no local Claude Code transcript to read");
} else {
  let humanTurns = 0;
  let toolResults = 0;
  let leaked = 0;
  for (const path of found.slice(0, 3)) {
    const parsed = parseTranscript(readFileSync(path, "utf8"));
    humanTurns += parsed.turns.filter((t) => t.role === "human").length;
    toolResults += parsed.toolResults;
    /*
     * The shape of the bug, looked for in the output rather than in the input: a tool result in
     * this corpus of transcripts is overwhelmingly a file listing or a diff, and both are dense
     * in path separators and line-number prefixes that human prose is not.
     */
    leaked += parsed.turns.filter(
      (turn) => turn.role === "human" && /^\s*\d+→/m.test(turn.text),
    ).length;
  }
  check(
    "real transcripts parse, and tool output dominates them",
    humanTurns > 0 && toolResults > humanTurns,
    `${humanTurns} human turns against ${toolResults} tool results in ${Math.min(3, found.length)} file(s)`,
  );
  check(
    "no parsed human turn looks like file output",
    leaked === 0,
    leaked === 0 ? "no line-numbered content in a human turn" : `${leaked} suspicious`,
  );
}

console.info("\nThe stored half keeps no transcript");

const { Client } = await import("pg");
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
    `select to_regclass('public.distill_runs') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — the migration is not applied yet");
  } else {
    /*
     * The property the whole privacy design rests on, asserted against `information_schema`
     * rather than against today's data — clean data says nothing about the next migration, which
     * is the line `verify:blocks` already holds for `skill_blocks`.
     */
    const { rows: columns } = await c.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'distill_runs'`,
    );
    const textish = columns.filter((col) => col.data_type === "text").map((col) => col.column_name);
    check(
      "a distill run has no column a transcript could be stored in",
      textish.every((name) =>
        ["org_id", "created_by", "label", "distill_version", "model"].includes(name),
      ),
      textish.join(", "),
    );
    check(
      "it does record what it read, so a parser regression would be visible",
      ["turns_read", "tool_results_dropped", "windows_sent"].every((name) =>
        columns.some((col) => col.column_name === name),
      ),
      "a run whose tool_results_dropped fell to zero would be one feeding files to a model",
    );

    /*
     * Exactly one origin, attempted rather than assumed.
     *
     * `verify:dedup` makes the same argument: clean data proves nothing about whether it can get
     * dirty again, so the check performs the insert that must fail and requires the failure.
     */
    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    if (org.length === 0) {
      console.info("  skip  no organisation to write a probe against");
    } else {
      await c.query("begin");
      try {
        let bothNullRefused = false;
        try {
          await c.query(
            `insert into interview_candidates (org_id, type, text) values ($1, 'guardrail', 'probe')`,
            [org[0].id],
          );
        } catch {
          bothNullRefused = true;
        }
        check(
          "a candidate with no origin at all is refused by the database",
          bothNullRefused,
          "both null is an orphan no accept path can resolve a draft for",
        );
      } finally {
        await c.query("rollback");
      }
    }

    const { rows: mixed } = await c.query<{ n: string }>(
      `select count(*)::text as n from interview_candidates
        where distill_run_id is not null and (session_id is not null or turn_id is not null)`,
    );
    check(
      "no stored candidate claims both origins",
      mixed[0].n === "0",
      "one counted twice would make the interview and distill accept rates disagree with their sum",
    );
  }
  await c.end();
}

console.info("\nThe model call is priced and gated");

{
  const { MODEL_DEFAULTS } = await import("../src/lib/models");
  const { rateFor, UNKNOWN_MODEL_RATE } = await import("../src/lib/llm-pricing");
  const { PLAN_FEATURES } = await import("../src/lib/plans");
  const { REVISION_REASONS } = await import("../src/lib/draft-blocks");

  const id = MODEL_DEFAULTS.distill;
  check(
    "the distill model has a real price entry",
    rateFor(id).inputPerMTok !== UNKNOWN_MODEL_RATE.inputPerMTok,
    id,
  );
  check(
    "distill is Pro and above, never free",
    !PLAN_FEATURES.free.includes("distill") &&
      PLAN_FEATURES.pro.includes("distill") &&
      PLAN_FEATURES.team.includes("distill"),
  );
  check(
    "an accepted distillation is distinguishable in the revision history",
    (REVISION_REASONS as readonly string[]).includes("distilled"),
    "`interview` on a distillation would make the two indistinguishable where an author looks",
  );
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
