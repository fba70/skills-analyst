/**
 * Distill mode (Doc 6 RW.5, plan step C4) — the transcript half.
 *
 * ## What this extracts, and what it must not
 *
 * A working session with an agent contains the knowledge its author never writes down: the
 * correction they make every time, the exception they always carve out, the thing they check
 * first because of something that went wrong two years ago. Interview mode (C2b) asks for it.
 * Distill takes it from work that already happened.
 *
 * Doc 6 is specific about the cost of getting this wrong — *"transcripts contain sensitive
 * content; distillation runs org-scoped, extracts **patterns** not verbatim text by default"*.
 * Three things follow, and they are all in this file because they must be checkable without a
 * model, a network or a database:
 *
 * 1. **A transcript is mostly not conversation.** See below; this is the finding that shapes
 *    everything else.
 * 2. **Tool output never reaches the model.** It is the bulk of the file and it is where the file
 *    contents, command output and credentials are.
 * 3. **Only the turns that look like a correction are sent at all.** That is the cost control and
 *    the signal filter at once, the same shape as E2's three filters before a conflict call.
 *
 * ## 94% of what looks like the user speaking is `cat` output
 *
 * A Claude Code transcript is JSONL, one object per line, and a naive reading is *keep every row
 * whose `type` is `user` or `assistant`*. Measured against three real transcripts from this
 * machine: **645 of 685 `user` rows carry a `tool_result` block and 40 carry human speech.**
 *
 * The harness feeds every tool result back as a `user` message, which is correct for the
 * protocol and catastrophic for a distiller: it would attribute the contents of every file read
 * during the session to the author, as things they said. The distinction is clean and was
 * verified rather than assumed — a `user` row's content is *either* a string (a person typed it)
 * *or* a list of `tool_result` blocks, never mixed, in 685 of 685 rows.
 */

/* ------------------------------------------------------------------ parsing */

/** The only two roles that survive parsing. Everything else in the file is housekeeping. */
export const TRANSCRIPT_ROLES = ["human", "assistant"] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export type TranscriptTurn = {
  role: TranscriptRole;
  text: string;
  /**
   * The row's own uuid, which is the provenance and the entire provenance.
   *
   * **The transcript is never stored.** A candidate records this id and a timestamp, so the
   * author can find the moment in their own file and nobody else can — the same property
   * `skill_blocks` gets from holding an offset instead of a passage, and a far stronger one here
   * because we do not hold the document the coordinate points into at all.
   */
  uuid: string | null;
  at: string | null;
  /** Position in the parsed sequence, so a window can be described without quoting it. */
  index: number;
};

export type ParseReport = {
  turns: TranscriptTurn[];
  /** Rows that were `user` but carried tool output. Counted, because the count is the finding. */
  toolResults: number;
  /** Model reasoning. Excluded: it is not the author's knowledge and it is noise. */
  thinking: number;
  /** `mode`, `permission-mode`, `atis-latch`, `ai-title`, `file-history-*` and friends. */
  housekeeping: number;
  malformed: number;
};

type Row = {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
};

/**
 * Parse a Claude Code transcript into the turns a person actually took part in.
 *
 * Pure, so `verify:distill` can assert the tool-output rule against a synthetic file and against
 * a real one without a network. Tolerant of bad lines, because a transcript is an append-only log
 * that can be truncated mid-write and refusing the whole file over its last line would be the
 * wrong trade.
 */
export function parseTranscript(jsonl: string): ParseReport {
  const report: ParseReport = { turns: [], toolResults: 0, thinking: 0, housekeeping: 0, malformed: 0 };
  let index = 0;

  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      report.malformed += 1;
      continue;
    }

    if (row.type !== "user" && row.type !== "assistant") {
      report.housekeeping += 1;
      continue;
    }

    const content = row.message?.content;

    if (row.type === "user") {
      /*
       * A string is a person typing. A list is the harness handing back tool output.
       *
       * This one branch is the difference between distilling somebody's judgement and distilling
       * the contents of their filesystem.
       */
      if (typeof content === "string") {
        const text = content.trim();
        if (text.length > 0) {
          report.turns.push({ role: "human", text, uuid: row.uuid ?? null, at: row.timestamp ?? null, index: index++ });
        }
        continue;
      }
      report.toolResults += 1;
      continue;
    }

    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const kind = (block as { type?: string }).type;
      if (kind === "thinking") {
        report.thinking += 1;
        continue;
      }
      /* `tool_use` carries arguments — file paths, commands, sometimes secrets. Never text. */
      if (kind !== "text") continue;
      const value = (block as { text?: unknown }).text;
      if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
    }
    if (parts.length > 0) {
      report.turns.push({
        role: "assistant",
        text: parts.join("\n\n"),
        uuid: row.uuid ?? null,
        at: row.timestamp ?? null,
        index: index++,
      });
    }
  }

  return report;
}

/* ---------------------------------------------------------------- redaction */

/**
 * Patterns redacted before a single character reaches the model.
 *
 * Deliberately blunt and deliberately not exhaustive: this is a second line, not the first. The
 * first is that tool output — where the overwhelming majority of secrets in a coding transcript
 * live — never leaves the parser. What survives to here is prose a person typed, and people
 * paste keys into prose.
 *
 * A redaction that removes a little too much costs a candidate block. One that removes too little
 * sends a credential to a third party, so the asymmetry decides the tuning.
 */
export const REDACTIONS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "bearer", pattern: /\b(?:bearer|token|api[_-]?key|secret)\s*[:=]\s*\S+/gi },
  { name: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "private-key", pattern: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g },
  { name: "url-credentials", pattern: /\b[a-z]+:\/\/[^\s:@/]+:[^\s@/]+@/gi },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

export const REDACTED = "[redacted]";

export function redact(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const rule of REDACTIONS) {
    out = out.replace(rule.pattern, () => {
      hits += 1;
      return REDACTED;
    });
  }
  return { text: out, hits };
}

/* ------------------------------------------------------- correction signals */

/**
 * What a correction looks like in a working transcript.
 *
 * The valuable turn is the one where the person pushes back: *no, use X*, *never do Y*, *actually
 * we always…*. That is knowledge the agent did not have and the author did, which is the exact
 * definition of what belongs in a skill.
 *
 * Matched on the **human** turn only, and on whole words, so "cannot" does not fire "not". Cheap
 * and free, and it is the filter that makes the model call affordable: a working session runs to
 * hundreds of turns and a handful of them are corrections.
 */
export const CORRECTION_CUES: readonly RegExp[] = [
  /\bno[,.]/i,
  /\bnot?\s+(?:like\s+)?that\b/i,
  /\bactually\b/i,
  /\binstead\b/i,
  /\bwrong\b/i,
  /\bnever\b/i,
  /\balways\b/i,
  /\bdon'?t\b/i,
  /\bshould(?:n'?t)?\b/i,
  /\bmust(?:n'?t)?\b/i,
  /\bprefer\b/i,
  /\brather than\b/i,
  /\bwe (?:use|do|keep|avoid)\b/i,
];

/** How many turns of context travel with a correction. */
export const CORRECTION_WINDOW = 2;

export type CorrectionWindow = {
  /** The human turn that carried the cue. */
  at: number;
  turns: TranscriptTurn[];
};

/**
 * The windows worth spending a model call on.
 *
 * A correction with no context is unusable — *"no, the other one"* means nothing alone — so each
 * carries the turns immediately before it. Overlapping windows are merged rather than sent twice,
 * because two calls over the same passage produce two candidates saying one thing, and R6.5's
 * dedup argument applies to a distiller as much as to a vote.
 */
export function correctionWindows(
  turns: readonly TranscriptTurn[],
  window = CORRECTION_WINDOW,
): CorrectionWindow[] {
  const hits: number[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role !== "human") continue;
    if (CORRECTION_CUES.some((cue) => cue.test(turn.text))) hits.push(i);
  }

  const out: CorrectionWindow[] = [];
  let lastEnd = -1;
  for (const at of hits) {
    const start = Math.max(0, at - window);
    const end = Math.min(turns.length - 1, at + 1);
    if (start <= lastEnd) {
      /* Merge: extend the previous window rather than sending an overlapping second call. */
      const previous = out[out.length - 1];
      previous.turns = turns.slice(
        Math.min(previous.turns[0]?.index ?? start, start),
        end + 1,
      );
      lastEnd = end;
      continue;
    }
    out.push({ at, turns: turns.slice(start, end + 1) });
    lastEnd = end;
  }
  return out;
}

/**
 * The most windows one run will send, whatever the transcript holds.
 *
 * A long session can carry a hundred corrections and a fuse is what keeps a single import from
 * being an unbounded bill — `MAX_BATCH` in the taxonomy classifier is the same idea and its own
 * comment calls it a fuse rather than a setting.
 */
export const MAX_WINDOWS_PER_RUN = 40;

/** Bumped when the distiller would extract differently. The re-run selector and R7.2. */
export const DISTILL_VERSION = "1.0.0";
