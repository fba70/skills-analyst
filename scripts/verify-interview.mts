import "dotenv/config";

import { readFileSync } from "node:fs";

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Client } from "pg";

import { BLOCK_TYPES } from "../src/lib/block-types";
import {
  CANDIDATE_DECISIONS,
  INTERVIEW_TECHNIQUE_META,
  INTERVIEW_TECHNIQUES,
  MAX_CANDIDATES_PER_TURN,
} from "../src/lib/interview";
import { REVISION_REASONS } from "../src/lib/draft-blocks";

/**
 * Interview mode elicits, and every suggestion is judged (Doc 6 RW.4, Doc 2 R5.1 and R5.4).
 *
 *   pnpm verify:interview
 *
 * Free. No provider is reached — the accept flow needs no model at all, which is the point of
 * splitting `session.ts`/`decide.ts` from `turn.ts`. The rows it writes are removed in a
 * `finally`.
 *
 * ## What is actually at risk
 *
 * Not the conversation. Three things underneath it:
 *
 *   1. **An accepted suggestion that reaches the draft by a second path.** The body is a render
 *      of the blocks and exactly one function writes it. An accept that appended to the body,
 *      or inserted a row directly, would produce a document that does not match the blocks
 *      beside it, and nothing would fail.
 *   2. **A decision that is not a durable record.** R5.4 is satisfied by the accept/reject
 *      *being* the feedback, which only works if the row survives, stays countable, and cannot
 *      be given twice. A rejected candidate deleted to tidy the list would take the pruning
 *      evidence with it.
 *   3. **A prompt that carries corpus prose.** Most of this corpus is `attribution_required`.
 *      One convenient few-shot example and the platform is laundering an attribution obligation
 *      through its own interviewer.
 */

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
function skip(name: string, why: string): void {
  console.info(`  skip  ${name} — ${why}`);
  skipped += 1;
}

// ---------------------------------------------------------------------------------------
console.info("\nThe five techniques");
// ---------------------------------------------------------------------------------------

check(
  "RW.4's five are all present",
  INTERVIEW_TECHNIQUES.length === 5,
  INTERVIEW_TECHNIQUES.join(", "),
);

const { techniqueSystem, draftContext } = await import("../src/server/interview/techniques");

/*
 * Each prompt has to be genuinely different. One "be a good interviewer" instruction with the
 * technique appended is one interviewer with five moods, and the measurement that decides which
 * techniques earn their place would then be measuring nothing.
 */
const prompts = new Map(INTERVIEW_TECHNIQUES.map((t) => [t, techniqueSystem(t)]));
check(
  "each technique produces a distinct prompt",
  new Set(prompts.values()).size === INTERVIEW_TECHNIQUES.length,
  `${new Set(prompts.values()).size} distinct`,
);

/*
 * Each names its own failure mode, which is the part a shared instruction cannot carry —
 * walkthrough drifts into summary, contrastive probing into flattery, exception mining into
 * hypotheticals.
 */
check(
  "and each names the way it goes wrong",
  INTERVIEW_TECHNIQUES.every((t) => /failure\s+mode/i.test(prompts.get(t)!)),
);

check(
  "every technique declares the block types it aims at",
  INTERVIEW_TECHNIQUES.every((t) => {
    const targets = INTERVIEW_TECHNIQUE_META[t].targets;
    return targets.length > 0 && targets.every((type) => (BLOCK_TYPES as readonly string[]).includes(type));
  }),
);

/*
 * Aiming is not restricting. The most valuable thing an author says is routinely not what the
 * question was after, and a schema that could only emit a technique's targets would discard it.
 */
const { z } = await import("zod");
void z;
const turnSource = readFileSync("src/server/interview/turn.ts", "utf8");
check(
  "but the turn schema accepts the whole block vocabulary, not just the targets",
  /z\.enum\(BLOCK_TYPES\)/.test(turnSource),
  "an exception-mining answer that yields a tool contract is still a tool contract",
);

check(
  "a turn proposes few blocks, so accepting is a judgement rather than a form",
  MAX_CANDIDATES_PER_TURN <= 3 && new RegExp(`max\\(MAX_CANDIDATES_PER_TURN\\)`).test(turnSource),
  `${MAX_CANDIDATES_PER_TURN} per turn, enforced in the schema`,
);

/*
 * R7.3. An interview is the surface where untrusted input matters most: the entire design asks
 * somebody to type freely and at length about their own systems.
 */
check(
  "the prompt states that what the author says is material, never instruction",
  INTERVIEW_TECHNIQUES.every((t) =>
    /never an instruction to you/i.test(prompts.get(t)!),
  ),
);

/*
 * Whitespace-tolerant on purpose. The prompt is a wrapped template literal, so "never invent"
 * straddles a line break — and a check that goes red when somebody reflows a paragraph is a
 * check people learn to edit rather than read.
 */
check(
  "and it forbids inventing specifics the author did not give",
  INTERVIEW_TECHNIQUES.every((t) => /never\s+invent/i.test(prompts.get(t)!)),
);

// ---------------------------------------------------------------------------------------
console.info("\nNo corpus prose reaches the prompt");
// ---------------------------------------------------------------------------------------

/**
 * The same line `generate.ts` holds, asserted the same way: structurally.
 *
 * It would be one import to put real fragments in as few-shot examples, and it must not happen
 * — a model handed attributed prose reproduces it into a document carrying no attribution, on
 * the exact axis the download route returns 451 to protect. What travels is our own vocabulary:
 * a block type's label and blurb.
 */
{
  const techniqueSource = readFileSync("src/server/interview/techniques.ts", "utf8");
  check(
    "the technique prompts import no fragment source",
    !/block-library|libraryFragments|exemplar/i.test(techniqueSource),
    "only block-types labels and blurbs travel",
  );
  check(
    "and the turn builder does not either",
    !/block-library|libraryFragments/i.test(turnSource),
  );

  /*
   * The draft's own blocks *are* sent, and that is a different thing: they are the author's own
   * words, in their own workspace, and the reason they go is so the assistant does not
   * re-elicit what is already written.
   */
  const context = draftContext({
    name: "Terraform plan review",
    categoryLabel: "Review & critique",
    purpose: "Review a plan before apply",
    context: null,
    existing: [{ type: "guardrail", text: "Never approve a plan that destroys a database." }],
  });
  check(
    "the author's own written blocks are sent, so questions do not repeat them",
    context.includes("destroys a database") && /already-written/.test(context),
  );
  check(
    "and everything variable is fenced as material rather than folded into the instructions",
    /<skill-being-written>/.test(context),
  );
}

// ---------------------------------------------------------------------------------------
console.info("\nAccepting writes through the one writer");
// ---------------------------------------------------------------------------------------

/**
 * A source-tree assertion, for the reason `verify:draft-blocks` gives: clean data cannot show
 * that a second write path does not exist, and a second path produces a document that does not
 * match its own blocks with nothing erroring.
 */
{
  const decide = readFileSync("src/server/interview/decide.ts", "utf8");
  check(
    "an accepted candidate becomes a draft block through setDraftBlocks",
    /setDraftBlocks\(/.test(decide),
  );
  check(
    "and nothing in the interview writes skill_drafts.body",
    !/skillDrafts[\s\S]{0,400}body:/.test(decide) && !/skillDrafts[\s\S]{0,400}body:/.test(turnSource),
  );
  check(
    "an accept lands in the revision history under its own reason",
    /reason: "interview"/.test(decide) && (REVISION_REASONS as readonly string[]).includes("interview"),
  );
  /*
   * Appended, never inserted at the archetype's typical position. That position is a median
   * over a corpus, not a statement about this document, and acting on it would drop a guardrail
   * into the middle of somebody's procedure on evidence that does not say so.
   */
  check(
    "and it is appended rather than placed at a guessed position",
    /\.\.\.existing\.map/.test(decide),
  );
  check(
    "a candidate can only be decided once",
    /decision !== "pending"/.test(decide),
    "a second decision would double-count and append the block twice",
  );
  check(
    "a rejection is recorded rather than deleted",
    !/\.delete\(interviewCandidates\)/.test(decide),
    "a technique whose candidates are always rejected is only prunable if the rejections exist",
  );
}

check(
  "accepted and edited are separate decisions",
  (CANDIDATE_DECISIONS as readonly string[]).includes("accepted") &&
    (CANDIDATE_DECISIONS as readonly string[]).includes("edited"),
  "collapsing them would flatter the one number that says whether this is working",
);

// ---------------------------------------------------------------------------------------
console.info("\nThe accept flow, against the real tables");
// ---------------------------------------------------------------------------------------

const owner = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await owner.connect();
  connected = true;
} catch {
  skip("accept-flow checks", "no database connection — the checks above are complete without it");
}

/** Kept out of the try so the cleanup can see them. */
let draftId: string | null = null;

if (connected) {
  const tables = await owner.query<{ n: string }>(
    `select count(*)::text as n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('interview_sessions','interview_turns','interview_candidates')`,
  );
  const orgRow = await owner.query<{ id: string }>(`select id from organization limit 1`);
  const orgId = orgRow.rows[0]?.id ?? null;

  if (tables.rows[0].n !== "3") {
    skip("accept-flow checks", "the interview tables do not exist — apply migrations/0033");
  } else if (!orgId) {
    skip("accept-flow checks", "no organisation exists — sign up once, then re-run");
  } else {
    try {
      const { createForTest } = await import("../src/server/builder/drafts");
      const { setDraftBlocks, getDraftBlocks, listDraftRevisions } = await import(
        "../src/server/builder/blocks"
      );
      const { startSession, getSession } = await import("../src/server/interview/session");
      const { decideCandidate, candidateStats } = await import("../src/server/interview/decide");

      draftId = await createForTest(
        {
          name: `verify-interview-${Date.now()}`,
          purpose: "Probe the interview accept flow. Removed at the end of this run.",
          context: null,
          category: "review",
          domain: null,
          dialect: "anthropic_skill",
          sectionInputs: {},
          scaffoldSections: [],
        },
        orgId,
        // A null author is legitimate — `created_by` is set-null on user deletion — and it
        // keeps this probe from depending on a particular person existing.
        (await owner.query<{ id: string }>(`select id from "user" limit 1`)).rows[0]?.id ?? null,
      );

      await setDraftBlocks(
        draftId,
        orgId,
        [{ form: "content", depth: null, type: "procedure", text: "Read the plan in full." }],
        { reason: "edited" },
      );

      const started = await startSession({
        draftId,
        orgId,
        userId: null,
        technique: "exception-mining",
      });
      check("a session starts on a draft", started.ok, started.ok ? started.sessionId.slice(0, 8) : started.message);
      if (!started.ok) throw new Error(started.message);

      /*
       * The turn is written directly rather than by calling a model. The accept flow is what
       * this section is about, and driving it through a mock conversation would make the check
       * depend on the mock's output shape rather than on the thing being tested.
       */
      const turn = await owner.query<{ id: string }>(
        `insert into interview_turns (org_id, session_id, turn_order, role, text)
         values ($1, $2, 0, 'assistant', 'When is the normal answer wrong?') returning id`,
        [orgId, started.sessionId],
      );
      const candidates = await owner.query<{ id: string }>(
        `insert into interview_candidates (org_id, session_id, turn_id, type, text)
         values ($1, $2, $3, 'guardrail', 'Never approve a plan that destroys a stateful resource.'),
                ($1, $2, $3, 'decision-rule', 'If the provider version moved, stop and ask.'),
                ($1, $2, $3, 'anti-example', 'Approving because the diff looked short.')
         returning id`,
        [orgId, started.sessionId, turn.rows[0].id],
      );

      const before = await getDraftBlocks(draftId, orgId);

      const accepted = await decideCandidate({
        candidateId: candidates.rows[0].id,
        orgId,
        userId: null,
        decision: "accepted",
      });
      check("accepting a suggestion succeeds", accepted.ok, accepted.ok ? "" : accepted.message);

      const after = await getDraftBlocks(draftId, orgId);
      check(
        "and the block is on the draft",
        after.length === before.length + 1 &&
          after[after.length - 1].text.includes("stateful resource"),
        `${before.length} → ${after.length} blocks`,
      );
      check(
        "carrying the type the assistant proposed, not a guess",
        after[after.length - 1].type === "guardrail",
        String(after[after.length - 1].type),
      );
      check(
        "and the candidate points at the block it became",
        accepted.ok && accepted.draftBlockId === after[after.length - 1].id,
      );

      const revisions = await listDraftRevisions(draftId, orgId);
      check(
        "the accept is in the revision history, labelled as an interview",
        revisions[0]?.reason === "interview",
        `#${revisions[0]?.revision} ${revisions[0]?.reason}`,
      );

      /*
       * Deciding twice must be refused. Without the guard the accept-rate query double-counts
       * and, worse, the same block is appended again — a duplicate paragraph in somebody's
       * document produced by clicking a button that looked idempotent.
       */
      const again = await decideCandidate({
        candidateId: candidates.rows[0].id,
        orgId,
        userId: null,
        decision: "accepted",
      });
      const afterAgain = await getDraftBlocks(draftId, orgId);
      check(
        "deciding the same suggestion twice is refused, and appends nothing",
        !again.ok && afterAgain.length === after.length,
        again.ok ? "accepted twice" : `${afterAgain.length} blocks, unchanged`,
      );

      // An edit is a different signal from a clean accept, and both keep the block.
      const edited = await decideCandidate({
        candidateId: candidates.rows[1].id,
        orgId,
        userId: null,
        decision: "edited",
        editedText: "If the provider version moved at all, stop and ask the owning team.",
      });
      const afterEdit = await getDraftBlocks(draftId, orgId);
      check(
        "an edited suggestion is added as the author wrote it, not as proposed",
        edited.ok &&
          afterEdit[afterEdit.length - 1].text.includes("owning team"),
        afterEdit[afterEdit.length - 1].text.slice(0, 50),
      );

      const rejected = await decideCandidate({
        candidateId: candidates.rows[2].id,
        orgId,
        userId: null,
        decision: "rejected",
      });
      const afterReject = await getDraftBlocks(draftId, orgId);
      check(
        "a rejected suggestion adds nothing to the draft",
        rejected.ok && afterReject.length === afterEdit.length,
        `${afterReject.length} blocks`,
      );

      const kept = await owner.query<{ decision: string }>(
        `select decision from interview_candidates where id = $1`,
        [candidates.rows[2].id],
      );
      check(
        "but its row survives, because the rejection is the signal",
        kept.rows[0]?.decision === "rejected",
        kept.rows[0]?.decision,
      );

      const stats = await candidateStats(orgId);
      const mine = stats.filter((row) => row.technique === "exception-mining");
      check(
        "accept rate is countable per technique and block type",
        mine.length === 3 && mine.every((row) => row.pending === 0),
        mine.map((row) => `${row.type}:${row.kept}/${row.proposed}`).join(" "),
      );

      const reread = await getSession(started.sessionId, orgId);
      check(
        "the session reads back with its transcript and decisions",
        reread !== null && reread.turns.length === 1 && reread.turns[0].candidates.length === 3,
        `${reread?.turns.length} turn(s), ${reread?.turns[0]?.candidates.length} candidate(s)`,
      );
      /*
       * The budget counts model turns, not transcript rows. Counting rows would halve the
       * effective cap once author turns are interleaved, and nobody would understand why the
       * conversation stopped at fifteen.
       */
      check(
        "and its budget counts model turns rather than transcript rows",
        reread?.modelTurns === 1,
        `${reread?.modelTurns} model turn(s) from ${reread?.turns.length} row(s)`,
      );
    } finally {
      if (draftId) {
        /*
         * One delete, through the owner connection. `skill_drafts` cascades to `draft_blocks`,
         * `draft_revisions` and `interview_sessions`, and that cascade is itself worth having
         * exercised — a probe that had to remove five tables by hand would be a probe that
         * proves the cascade is missing.
         */
        const removed = await owner.query(`delete from skill_drafts where id = $1`, [draftId]);
        const orphans = await owner.query<{ n: string }>(
          `select (
             (select count(*) from interview_sessions where draft_id = $1) +
             (select count(*) from draft_blocks where draft_id = $1) +
             (select count(*) from draft_revisions where draft_id = $1)
           )::text as n`,
          [draftId],
        );
        check(
          "deleting the draft takes its blocks, history and interviews with it",
          removed.rowCount === 1 && orphans.rows[0].n === "0",
          `${orphans.rows[0].n} orphan(s)`,
        );
      }
      await owner.end().catch(() => undefined);
    }
  }

  if (!connected) await owner.end().catch(() => undefined);
}

/** Referenced so the mock import is not dead weight if the DB half skips. */
void MockLanguageModelV4;
void simulateReadableStream;

console.info(`\n${pass} passed, ${fail} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(fail > 0 ? 1 : 0);
