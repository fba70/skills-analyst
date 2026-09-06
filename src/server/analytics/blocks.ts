import "server-only";

import { BLOCK_TYPES, type BlockKind, type BlockType } from "@/lib/block-types";

import type { SectionRole } from "./structure";

/**
 * Block segmentation and typing (Doc 6 RW.1 / RW.2).
 *
 * Turns one skill body into a list of typed spans. Pure rules: no model, no network, no
 * database, so re-extraction is free and the output is reproducible from the bundle alone
 * (R7.2) — the same contract `extractStructure` already holds, for the same reason.
 *
 * ## Two passes, because shape and meaning are different questions
 *
 * **Segment first.** A markdown body is already divided by its own syntax: a fenced block,
 * a run of list items, a table, a blockquote, a paragraph. That division needs no
 * interpretation and is where a block boundary actually is. Guessing boundaries from
 * meaning — "this sentence starts a new idea" — is the part a rule cannot do, and skipping
 * it costs nothing because authors have already marked the boundaries.
 *
 * **Then type.** Each segment is matched against an ordered rule table, first match wins.
 * The order encodes one principle: **structure beats lexicon.** An ordered list of five
 * steps is a procedure even when step three says "never commit secrets"; a bulleted list of
 * nevers with no ordering is a guardrail. Getting that the wrong way round makes every
 * procedure in the corpus a guardrail, because procedures are full of modal verbs.
 *
 * ## Spans, never text
 *
 * A block row stores `[startChar, endChar)` into the body and no content. That is what lets
 * a block library exist for a `metadata_only` skill without mirroring a byte of it: the
 * coordinate is meaningless without the bundle, and the bundle is behind the licence gate
 * (R1.6). A fragment is resolved live, exactly as an archetype exemplar is resolved live
 * rather than stored — and for the same reason, so that a skill withdrawn since extraction
 * stops being quotable immediately.
 *
 * Character offsets, not bytes, and named `startChar`/`endChar` so the unit is not a thing
 * anyone has to infer. `body.slice(startChar, endChar)` is the whole resolution contract and
 * `verify:blocks` asserts it round-trips.
 *
 * ## The bare code fence stays unclassified, deliberately
 *
 * The first probe left ~570 fenced blocks with no type: no shell language, no CLI runner,
 * no example cue above them. Typing them `example` would classify most of them and would
 * be a lie with consequences — Doc 6 sells `example` blocks as "convertible straight into
 * an eval case" (RW.6), and a YAML config fence is not an input/output pair. "We found 204
 * examples" is a claim RW.6 can stand on; "we found 700" is one that collapses the first
 * time somebody tries to generate eval cases from them. Same lesson as the taxonomy's
 * no-description rule: a threshold tuned to clear the queue buys queue depth with
 * correctness.
 *
 * ## What it deliberately does not do
 *
 * A fence indented inside a list item is read as list content rather than as its own code
 * block. Real, known, and not worth a markdown parser: the segment still lands with the
 * right type and the right span, only its `kind` is coarser. If that ever matters, it is a
 * parser swap behind this function's signature, not a redesign.
 */

/** The cue that fired, from a closed vocabulary we define. Stored, because a rejected */
/** measurement that leaves no trace has to be paid for twice (the v7 archetype lesson). */
export type BlockRule =
  | "stance:persona"
  | "anti-example:marker"
  | "anti-example:limitations-section"
  | "anti-example:mistakes-section"
  | "glossary:definition-list"
  | "glossary:heading"
  | "glossary:term-table"
  | "tool-contract:shell-code"
  | "tool-contract:cli-invocation"
  | "tool-contract:script-reference"
  | "output-spec:output-section"
  | "output-spec:format-cue"
  | "example:input-output-pair"
  | "example:examples-section"
  | "example:marked-code"
  | "reference-pointer:link-list"
  | "reference-pointer:references-section"
  | "reference-pointer:bundle-path"
  | "procedure:ordered-list"
  | "procedure:steps-section"
  | "procedure:numbered-prose"
  | "procedure:steps-prose"
  | "trigger:when-to-use-section"
  | "trigger:trigger-cue"
  | "decision-rule:conditional"
  | "decision-rule:decision-table"
  | "guardrail:modal"
  | "guardrail:rules-section"
  | "procedure:imperative-list";

/** Cheap, rules-only features. Every one is a number, a boolean or a closed enum. */
export type BlockFeatures = {
  kind: BlockKind;
  /** List items, or table rows excluding the header. Zero for prose and code. */
  itemCount: number;
  /** An ordered (numbered) list. The strongest procedure signal there is. */
  ordered: boolean;
  /** Fence language as written, lowercased, when the segment is code. */
  codeLanguage: string | null;
  charCount: number;
  wordCount: number;
  lineCount: number;
  linkCount: number;
  /** Links pointing inside the bundle — real progressive disclosure (R2.7). */
  internalLinkCount: number;
  /** Opens with an imperative verb: the shape a verifiable step has. */
  hasImperative: boolean;
  /** Carries a modal must/never. Guardrail strength. */
  hasModal: boolean;
  /** Carries an if/when/unless. Decision coverage. */
  hasConditional: boolean;
};

export type SkillBlock = {
  /** Position in the document, 0-based, over every segment including unclassified ones. */
  order: number;
  /** `null` when no rule recognised it. Content, not an error — see `block-types.ts`. */
  type: BlockType | null;
  /** Which rule fired, or `null` alongside a `null` type. */
  rule: BlockRule | null;
  /** Role of the enclosing heading; `null` for the preamble above the first heading. */
  parentRole: SectionRole | null;
  /** Index into the fingerprint's `headings`, so a block can be traced to its section. */
  parentHeadingOrder: number | null;
  startChar: number;
  endChar: number;
  /**
   * Context-token cost of this block, estimated.
   *
   * Deliberately an estimate and named as one: a real tokenizer is a dependency this
   * project has not taken, and RW.9's honest claim needs a measured number, so A3 owns
   * that and this stays the free approximation. Prose runs about four characters to the
   * token and code about three, because identifiers and punctuation split more often.
   */
  tokenEstimate: number;
  features: BlockFeatures;
};

// ---------------------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------------------

type Segment = {
  kind: BlockKind;
  text: string;
  startChar: number;
  endChar: number;
  lineCount: number;
  ordered: boolean;
  itemCount: number;
  codeLanguage: string | null;
  parentRole: SectionRole | null;
  parentHeadingOrder: number | null;
};

type Line = { text: string; start: number; end: number };

/** Lines with their character offsets into the original body, newline excluded. */
function lineIndex(body: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= body.length) {
    const nl = body.indexOf("\n", start);
    const end = nl === -1 ? body.length : nl;
    const text = body.slice(start, end).replace(/\r$/, "");
    lines.push({ start, end: start + text.length, text });
    if (nl === -1) break;
    start = nl + 1;
  }
  return lines;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+\S/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const QUOTE_LINE = /^\s*>/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/**
 * A horizontal rule is punctuation, not content.
 *
 * It was landing as its own paragraph segment, and under an "## Anti-patterns" heading a
 * bare `---` was duly typed as an anti-example. A block whose entire content is a
 * separator is noise in the count and worse than noise in a library — the compose step
 * would offer it as a fragment.
 */
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

export type SegmentContext = {
  /** `(depth, text, role, order)` from the fingerprint, in document order. */
  headings: ReadonlyArray<{ role: SectionRole | null; text: string; order: number }>;
};

/**
 * Split a body into segments, each tagged with the section it sits in.
 *
 * Walks by index with explicit lookahead rather than carrying a state machine across
 * iterations: a loose list separated by blank lines is one segment, and deciding that needs
 * to see the line after the blank. The version of this that tracked "am I in a list" in a
 * flag split every loose list into one segment per item.
 */
function segmentBody(body: string, context: SegmentContext): Segment[] {
  const lines = lineIndex(body);
  const segments: Segment[] = [];

  let parentRole: SectionRole | null = null;
  let parentHeadingOrder: number | null = null;
  let headingCursor = 0;

  const push = (
    kind: BlockKind,
    from: number,
    to: number,
    extra: Partial<Segment> = {},
  ): void => {
    const startChar = lines[from].start;
    const endChar = lines[to].end;
    const text = body.slice(startChar, endChar);
    if (text.trim().length === 0) return;
    segments.push({
      kind,
      text,
      startChar,
      endChar,
      lineCount: to - from + 1,
      ordered: false,
      itemCount: 0,
      codeLanguage: null,
      parentRole,
      parentHeadingOrder,
      ...extra,
    });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.text.trim();

    if (trimmed.length === 0 || HORIZONTAL_RULE.test(line.text)) {
      i += 1;
      continue;
    }

    // A fence runs to its matching close, or to the end of the document if unclosed.
    const fence = trimmed.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const rawLang = fence[2].trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      const codeLanguage = /^[a-z0-9+#._-]{1,20}$/.test(rawLang) ? rawLang : null;
      let j = i + 1;
      while (j < lines.length) {
        const close = lines[j].text.trim().match(FENCE);
        if (close && close[1][0] === marker) break;
        j += 1;
      }
      const last = Math.min(j, lines.length - 1);
      push("code", i, last, { codeLanguage });
      i = last + 1;
      continue;
    }

    // A heading is a boundary and a label, never a block of its own: it is already the
    // fingerprint's unit, and duplicating it here would double-count every section.
    const heading = trimmed.match(HEADING);
    if (heading) {
      const text = heading[2].trim().slice(0, 200);
      // Match against the fingerprint's own list, in order, so the two agree by
      // construction rather than by both re-deriving the same regex.
      const found = context.headings.findIndex((h, index) => index >= headingCursor && h.text === text);
      if (found >= 0) {
        parentRole = context.headings[found].role;
        parentHeadingOrder = context.headings[found].order;
        headingCursor = found + 1;
      } else {
        parentRole = null;
        parentHeadingOrder = null;
      }
      i += 1;
      continue;
    }

    if (TABLE_ROW.test(line.text)) {
      let j = i;
      while (j + 1 < lines.length && TABLE_ROW.test(lines[j + 1].text)) j += 1;
      // Header plus separator are not data. A two-line table has zero rows, which is
      // right: it is a header with nothing under it.
      const rows = Math.max(0, j - i + 1 - 2);
      push("table", i, j, { itemCount: rows });
      i = j + 1;
      continue;
    }

    if (QUOTE_LINE.test(line.text)) {
      let j = i;
      while (j + 1 < lines.length && QUOTE_LINE.test(lines[j + 1].text)) j += 1;
      push("quote", i, j);
      i = j + 1;
      continue;
    }

    if (LIST_ITEM.test(line.text)) {
      let j = i;
      let itemCount = 0;
      let ordered = false;
      let k = i;
      while (k < lines.length) {
        const text = lines[k].text;
        if (LIST_ITEM.test(text)) {
          itemCount += 1;
          if (ORDERED_ITEM.test(text)) ordered = true;
          j = k;
          k += 1;
          continue;
        }
        // Indented continuation of the current item.
        if (text.trim().length > 0 && /^\s{2,}\S/.test(text)) {
          j = k;
          k += 1;
          continue;
        }
        // A single blank line keeps a loose list together, if a list line follows it.
        if (text.trim().length === 0) {
          let ahead = k + 1;
          while (ahead < lines.length && lines[ahead].text.trim().length === 0) ahead += 1;
          if (
            ahead < lines.length &&
            (LIST_ITEM.test(lines[ahead].text) || /^\s{2,}\S/.test(lines[ahead].text)) &&
            ahead - k === 1
          ) {
            k = ahead;
            continue;
          }
        }
        break;
      }
      push("list", i, j, { itemCount, ordered });
      i = j + 1;
      continue;
    }

    // Prose runs to the next blank line or structural line.
    let j = i;
    while (j + 1 < lines.length) {
      const next = lines[j + 1].text;
      if (
        next.trim().length === 0 ||
        HORIZONTAL_RULE.test(next) ||
        HEADING.test(next.trim()) ||
        FENCE.test(next.trim()) ||
        TABLE_ROW.test(next) ||
        QUOTE_LINE.test(next) ||
        LIST_ITEM.test(next)
      ) {
        break;
      }
      j += 1;
    }
    push("paragraph", i, j);
    i = j + 1;
  }

  return segments;
}

// ---------------------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------------------

const PERSONA =
  /\b(you are (an?|the)\b|act as (an?|the)\b|your role is\b|you'?re acting as\b|adopt the (role|persona|voice)\b|think like (an?|the)\b|assume the role\b|as (an?|the) [a-z-]{3,20}, you\b)/i;

/**
 * Anti-example cues, in two forms, after reading real matches.
 *
 * This is the rarest and most valuable type (Doc 6 §2), so the temptation is to cast a wide
 * net. The opposite is right, and a probe over 300 real skills showed why. "instead of",
 * "naive" and "mistakenly" fire on ordinary prose and were dropped before the first run.
 * Then `wrong`, `bad` and `incorrect` matched anywhere turned out to catch sentences like
 * "if the answer is wrong, retry" — a decision rule — and "most bad decisions happen here",
 * which is an observation.
 *
 * So the cues split by how much the wording commits. `ANTI_STRONG` phrases only ever
 * introduce a failure mode and match anywhere in the passage. `ANTI_LABELLED` catches the
 * "❌ Wrong:" / "**Bad:**" convention, where the word is doing structural work as a label,
 * and therefore only matches at the start of a line or list item.
 *
 * The cue is tested against the passage's **own text only**. Reading the previous paragraph
 * and the heading — which the first version did — bled the type across whole sections: one
 * "Watch for these redirections" heading turned every block under it into an anti-example,
 * including "Used across every skill in this repo, defined only here."
 */
const ANTI_STRONG =
  /(❌|✗|🚫|⛔|\banti-?patterns?\b|\bcommon (mistakes?|errors?|pitfalls?)\b|\bwhat not to do\b|\bcounter-?examples?\b|\bfailure modes?\b|\bdo not do (this|that)\b|\bdon'?t do (this|that)\b|\bthis (fails|breaks) (when|because)\b|\bgotchas?\b)/i;
/**
 * The "❌ Wrong:" convention only — the word must be doing the work of a label.
 *
 * `do not`, `never do` and `avoid` were in here for one run and were wrong: they are how a
 * *guardrail* is phrased ("- Do not disable the pre-commit hook"), so every prohibition
 * list in the corpus came back as a failure mode. What distinguishes a label is the
 * punctuation after it, so that is what is required.
 */
const ANTI_LABELLED =
  /(^|\n)\s*(?:[-*+>]\s*)?[*_`]*\s*(wrong|incorrect|bad|worse)\b[*_`]*\s*[:—–-]/i;

/**
 * A heading that declares the whole section to be about failure — tier 2, not a bleed.
 *
 * Different evidence from the previous-paragraph matching that was removed: under
 * "## Anti-patterns" every passage really is an anti-example, because the author said so.
 * The section role for these headings is `troubleshooting`, which is broader than mistakes
 * and cannot stand in for this.
 */
const ANTI_HEADING =
  /\b(anti-?patterns?|common (mistakes?|errors?|pitfalls?)|pitfalls?|what not to do|failure modes?|gotchas?|mistakes|misuse)\b/i;

const GLOSSARY_HEADING =
  /\b(glossar\w*|terminolog\w*|definitions?|vocabular\w*|nomenclature|key terms?)\b/i;
/** `**Term** — definition` or `- **Term**: definition`, twice or more. */
const DEFINITION_ITEM = /^\s*(?:[-*+]\s+)?\*\*[^*\n]{1,60}\*\*\s*[-—–:]\s*\S/gm;
const TERM_TABLE_HEADER = /^\s*\|\s*\**\s*(term|name|word|concept|field|key)s?\b/i;
const TERM_TABLE_SECOND = /\b(meaning|definition|description|what it (is|does)|explanation)\b/i;

const SHELL_LANGS = new Set([
  "bash", "sh", "zsh", "shell", "console", "terminal", "cmd", "bat", "powershell", "ps1",
]);
const CLI_RUNNER =
  /^\s*(?:\$\s*|>\s*)?(npm|pnpm|npx|yarn|bun|bunx|node|deno|python3?|pip3?|uv|uvx|ruby|gem|go|cargo|rustc|make|just|task|curl|wget|git|gh|docker|docker-compose|podman|kubectl|helm|terraform|tofu|ansible|aws|gcloud|az|vercel|wrangler|psql|mysql|sqlite3|redis-cli|jq|yq|sed|awk|grep|rg|fd|find|tar|zip|unzip|chmod|chown|mkdir|rsync|ssh|scp|systemctl|brew|apt|apt-get|yum|dnf|pacman|\.\/[\w.-]+)\b/m;
const SCRIPT_INVOCATION =
  /\b(run|runs|execute|executes|invoke|invokes|call|calls|use)\b[^.\n]{0,80}?((?:scripts?|bin|tools?)\/[\w./-]+|[\w.-]+\.(py|sh|js|mjs|cjs|ts|rb|pl|ps1))\b/i;

const FORMAT_CUE =
  /\b(output (must|should|has to|format|shape)|returns? (a|an|the)\b|respond (with|in|using)|response (must|should|format)|format (must|should|is)|structure (your|the) (output|response|answer|report)|(json|yaml|xml|markdown|csv) (schema|structure|format)|use (this|the following) (format|template|structure)|report (format|template)|must (be|contain|include|return|emit)\b|emit (a|an|the)\b|deliverables? (must|should))\b/i;

const INPUT_MARKER = /(^|\n)\s*(?:[-*+>]\s*)?\**\s*(input|given|request|prompt|query|before|source)\b\s*\**\s*:/i;
const OUTPUT_MARKER = /(^|\n)\s*(?:[-*+>]\s*)?\**\s*(output|result|response|returns|expected|after|becomes|produces)\b\s*\**\s*:/i;
const EXAMPLE_CUE =
  /\b(for example|example|examples|e\.?g\.?|sample|for instance|suppose|say (you|the)|imagine|consider (this|the following)|here'?s (an?|how))\b/i;

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const POINTER_CUE =
  /\b(see|refer to|read|consult|full (details?|list|reference|spec)|more (detail|information|info)|documented in|described in|available in|listed in|found in|details? (are )?in|further reading)\b/i;
const BUNDLE_PATH = /\b(references?|scripts?|assets?|templates?|docs?)\/[\w.\-/]+/i;

const TRIGGER_CUE =
  /\b(use (this|it|the skill|this skill)?\s*when|use when|invoke (this )?when|trigger(s|ed)? (when|on|by|if)|activate(d)? when|applies? when|applicable when|reach for (this|it)|when the user (asks|requests|wants|says|needs|mentions)|if the user (asks|requests|wants|says|needs|mentions)|call this (skill )?when|only use (this|it)|use this skill (to|for|when))\b/i;

const CONDITIONAL_CUE =
  /\b(if\b[^.\n]{3,140}?\b(then|,)\s*\w|when\b[^.\n]{3,140}?\b(then|,)\s*(use|do|run|apply|prefer|choose|set|add|skip|stop|return|report|escalate)|otherwise\b|else if\b|unless\b|depending on\b|in (that|this) case\b|whichever\b|either way\b|fall(s)? back to\b)/i;
const DECISION_TABLE_HEADER =
  /^\s*\|\s*\**\s*(if|when|case|condition|scenario|situation|state|input|symptom|trigger)s?\b/i;

const MODAL_CUE =
  /\b(never|must not|must never|do not|don'?t|cannot|can'?t|shall not|always|must|shall|required|ensure|make sure|under no circumstances|forbidden|not allowed|prohibited|refuse|mandatory|no exceptions|critical|important|warning|caution|do NOT)\b/;

const IMPERATIVE_OPENER =
  /^(use|create|generate|build|write|review|analy[sz]e|extract|convert|transform|validate|check|run|deploy|manage|automate|fetch|query|search|summari[sz]e|translate|format|lint|test|debug|refactor|scaffold|plan|design|draft|audit|monitor|track|send|read|parse|render|export|import|sync|configure|set|install|add|apply|compare|evaluate|explain|guide|help|find|list|update|migrate|optimi[sz]e|clean|process|handle|integrate|connect|orchestrate|coordinate|capture|record|publish|schedule|open|close|start|stop|verify|confirm|ask|call|copy|move|remove|replace|rename|split|merge|group|sort|filter|count|measure|report|note|identify|determine|decide|choose|select|pick|prepare|ensure|make|do|go|look|scan|inspect|collect|gather|load|save|store|fix|repeat|continue|return|output|emit|print|show|display|include|exclude|avoid|prefer|keep|leave|wait|retry|escalate)\b/i;

/** Strips list markers and inline decoration so an opener test sees the first real word. */
function firstWords(text: string): string {
  return text
    .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
    .replace(/^[#>\s]+/, "")
    .replace(/[`*_~]/g, "")
    .trim();
}

function countMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

/** Share of list items that open with an imperative verb. Zero for a non-list. */
function imperativeItemShare(segment: Segment): number {
  if (segment.kind !== "list" || segment.itemCount === 0) return 0;
  const items = segment.text.split(/\r?\n/).filter((l) => LIST_ITEM.test(l));
  if (items.length === 0) return 0;
  const hits = items.filter((l) => IMPERATIVE_OPENER.test(firstWords(l))).length;
  return hits / items.length;
}

// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

type RuleContext = {
  segment: Segment;
  /** The paragraph immediately above, if any — where "Example:" and "❌ Wrong:" live. */
  previous: Segment | null;
  /** Heading text of the enclosing section, for the rules that read it. */
  headingText: string;
  index: number;
  features: BlockFeatures;
};

type Rule = { rule: BlockRule; type: BlockType; test: (c: RuleContext) => boolean };

/**
 * Ordered. First match wins. Grouped into four tiers of evidence strength.
 *
 * The tiers exist because a flat list got the same class of thing wrong twice, in opposite
 * directions, and both were only visible against real bundles.
 *
 * **Tier 1 — the passage's own syntax.** A shell fence, a definition list, a decision table.
 * These need no interpretation: the author wrote a structure that means one thing.
 *
 * **Tier 2 — the section the author declared.** A passage under "When to use this" is a
 * trigger because its author said so by writing that heading. This beats tier 3 on purpose:
 * an author's own labelling of a section is better evidence than our reading of the shape
 * inside it.
 *
 * **Tier 3 — structure inside the passage.** An ordered list of two or more items is a
 * procedure. This is where **structure beats lexicon**, which is the load-bearing rule of
 * the whole table: procedures are written in modal verbs — "run the dry run, you must never
 * skip it" — so a lexical guardrail rule above this one types every numbered procedure in
 * the corpus as a guardrail. Measured on the first pass: it did exactly that. The same trap
 * caught `anti-example` a run later, because a numbered procedure containing "don't skip
 * past errors" was typed as a failure mode.
 *
 * **Tier 4 — wording.** Everything that rests on a cue rather than on a shape. Weakest, and
 * last, so a cue can only decide a passage no structure and no heading has claimed.
 */
const RULES: readonly Rule[] = [
  // ---- Tier 1: the passage's own syntax ------------------------------------------------
  // A stance is a framing move and lives at the top of a document. Position is part of the
  // evidence: "you are an expert" in paragraph forty is quoting something.
  {
    rule: "stance:persona",
    type: "stance",
    test: (c) =>
      c.segment.kind !== "code" &&
      PERSONA.test(c.segment.text) &&
      (c.index <= 3 || c.segment.parentRole === "purpose" || c.segment.parentRole === null),
  },
  {
    rule: "glossary:definition-list",
    type: "glossary",
    test: (c) =>
      (c.segment.kind === "list" || c.segment.kind === "paragraph") &&
      countMatches(c.segment.text, DEFINITION_ITEM) >= 2,
  },
  {
    rule: "glossary:term-table",
    type: "glossary",
    test: (c) => {
      if (c.segment.kind !== "table") return false;
      const header = c.segment.text.split(/\r?\n/)[0] ?? "";
      return TERM_TABLE_HEADER.test(header) && TERM_TABLE_SECOND.test(header);
    },
  },
  {
    rule: "decision-rule:decision-table",
    type: "decision-rule",
    test: (c) =>
      c.segment.kind === "table" &&
      DECISION_TABLE_HEADER.test(c.segment.text.split(/\r?\n/)[0] ?? ""),
  },
  {
    rule: "tool-contract:shell-code",
    type: "tool-contract",
    test: (c) => c.segment.kind === "code" && SHELL_LANGS.has(c.segment.codeLanguage ?? ""),
  },

  // ---- Tier 2: the section the author declared -----------------------------------------
  {
    rule: "trigger:when-to-use-section",
    type: "trigger",
    test: (c) => c.segment.parentRole === "when-to-use",
  },
  {
    rule: "output-spec:output-section",
    type: "output-spec",
    test: (c) => c.segment.parentRole === "output-format",
  },
  {
    rule: "example:examples-section",
    type: "example",
    test: (c) => c.segment.parentRole === "examples",
  },
  {
    rule: "reference-pointer:references-section",
    type: "reference-pointer",
    test: (c) => c.segment.parentRole === "references" && c.features.linkCount > 0,
  },
  {
    rule: "anti-example:limitations-section",
    type: "anti-example",
    test: (c) => c.segment.parentRole === "limitations" && c.features.hasModal,
  },
  {
    rule: "anti-example:mistakes-section",
    type: "anti-example",
    test: (c) => ANTI_HEADING.test(c.headingText),
  },
  {
    rule: "procedure:steps-section",
    type: "procedure",
    test: (c) =>
      c.segment.parentRole === "steps" && c.segment.kind === "list" && c.segment.itemCount >= 2,
  },
  {
    // A glossary heading is the author declaring the section, same tier as the rest.
    rule: "glossary:heading",
    type: "glossary",
    test: (c) => GLOSSARY_HEADING.test(c.headingText),
  },

  // ---- Tier 3: structure inside the passage --------------------------------------------
  // Structure beats lexicon. See the note above the table; this line is the whole reason
  // the table is ordered rather than a switch on cues.
  {
    rule: "procedure:ordered-list",
    type: "procedure",
    test: (c) => c.segment.kind === "list" && c.segment.ordered && c.segment.itemCount >= 2,
  },
  {
    rule: "tool-contract:cli-invocation",
    type: "tool-contract",
    test: (c) => c.segment.kind === "code" && CLI_RUNNER.test(c.segment.text),
  },
  {
    rule: "example:input-output-pair",
    type: "example",
    test: (c) => {
      const text = c.previous ? `${c.previous.text}\n${c.segment.text}` : c.segment.text;
      return INPUT_MARKER.test(text) && OUTPUT_MARKER.test(text);
    },
  },
  {
    rule: "reference-pointer:link-list",
    type: "reference-pointer",
    test: (c) =>
      c.segment.kind === "list" &&
      c.features.linkCount > 0 &&
      c.segment.itemCount > 0 &&
      c.features.linkCount / c.segment.itemCount >= 0.5,
  },
  {
    rule: "procedure:numbered-prose",
    type: "procedure",
    test: (c) =>
      c.segment.kind === "paragraph" && countMatches(c.segment.text, /^\s*\d+[.)]\s+\S/m) >= 2,
  },

  // ---- Tier 4: wording ------------------------------------------------------------------
  {
    rule: "anti-example:marker",
    type: "anti-example",
    test: (c) => ANTI_STRONG.test(c.segment.text) || ANTI_LABELLED.test(c.segment.text),
  },
  {
    rule: "tool-contract:script-reference",
    type: "tool-contract",
    test: (c) => c.segment.kind !== "code" && SCRIPT_INVOCATION.test(c.segment.text),
  },
  {
    rule: "output-spec:format-cue",
    type: "output-spec",
    test: (c) => c.segment.kind !== "code" && FORMAT_CUE.test(c.segment.text),
  },
  {
    rule: "example:marked-code",
    type: "example",
    test: (c) =>
      c.segment.kind === "code" &&
      c.previous !== null &&
      c.previous.kind !== "code" &&
      EXAMPLE_CUE.test(c.previous.text),
  },
  {
    rule: "reference-pointer:bundle-path",
    type: "reference-pointer",
    test: (c) =>
      c.segment.kind !== "code" &&
      BUNDLE_PATH.test(c.segment.text) &&
      POINTER_CUE.test(c.segment.text),
  },
  {
    rule: "trigger:trigger-cue",
    type: "trigger",
    test: (c) => c.segment.kind !== "code" && TRIGGER_CUE.test(c.segment.text),
  },
  {
    rule: "decision-rule:conditional",
    type: "decision-rule",
    test: (c) => c.segment.kind !== "code" && CONDITIONAL_CUE.test(c.segment.text),
  },
  {
    rule: "guardrail:modal",
    type: "guardrail",
    test: (c) => c.segment.kind !== "code" && c.features.hasModal,
  },
  {
    rule: "guardrail:rules-section",
    type: "guardrail",
    test: (c) => c.segment.parentRole === "rules" && c.segment.kind !== "code",
  },
  /**
   * Prose under a steps heading that opens with an imperative.
   *
   * Added after the first probe, which found 904 unclassified paragraphs sitting under
   * `steps` — a real gap, since plenty of authors write the procedure as prose rather than
   * as a list. Requires both the section role and an imperative opener, so a paragraph of
   * explanation under the same heading stays unclassified.
   */
  {
    rule: "procedure:steps-prose",
    type: "procedure",
    test: (c) =>
      c.segment.kind === "paragraph" &&
      c.segment.parentRole === "steps" &&
      c.features.hasImperative,
  },
  // Last, and weak on purpose: a list of imperatives that is not numbered and not under a
  // steps heading is probably a procedure, but it is the guess of the table, not a finding.
  {
    rule: "procedure:imperative-list",
    type: "procedure",
    test: (c) =>
      c.segment.kind === "list" && c.segment.itemCount >= 2 && imperativeItemShare(c.segment) >= 0.6,
  },
];

/**
 * Every rule name that can actually fire, derived from the table rather than restated.
 *
 * Same argument as `ANALYZER_VERSIONS` being derived from the analyzer objects: a
 * vocabulary a checker validates against has to come from the thing that produces it, or
 * the two drift and the check silently starts approving values nothing emits — or worse,
 * rejecting ones it does. `BlockRule` is a compile-time union and cannot be inspected at
 * runtime, so this is the runtime half of the same list, and it is impossible for it to
 * disagree with `RULES`.
 */
export const BLOCK_RULES: readonly string[] = RULES.map((r) => r.rule);

function featuresOf(segment: Segment, bundlePaths: ReadonlySet<string>): BlockFeatures {
  const links = [...segment.text.matchAll(LINK)];
  let internal = 0;
  for (const match of links) {
    const target = match[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
    const withoutAnchor = target.split("#")[0].replace(/^\.\//, "");
    if (withoutAnchor.length === 0) continue;
    if (
      bundlePaths.has(withoutAnchor) ||
      [...bundlePaths].some((p) => p.endsWith(`/${withoutAnchor}`))
    ) {
      internal += 1;
    }
  }

  const charCount = segment.text.length;
  return {
    kind: segment.kind,
    itemCount: segment.itemCount,
    ordered: segment.ordered,
    codeLanguage: segment.codeLanguage,
    charCount,
    wordCount: segment.text.split(/\s+/).filter(Boolean).length,
    lineCount: segment.lineCount,
    linkCount: links.length,
    internalLinkCount: internal,
    hasImperative: IMPERATIVE_OPENER.test(firstWords(segment.text)),
    hasModal: MODAL_CUE.test(segment.text),
    hasConditional: CONDITIONAL_CUE.test(segment.text),
  };
}

/** Prose runs ~4 chars per token, code ~3: identifiers and punctuation split more often. */
function estimateTokens(segment: Segment): number {
  const divisor = segment.kind === "code" ? 3 : 4;
  return Math.max(1, Math.ceil(segment.text.length / divisor));
}

export type BlockExtractInput = {
  /** Marker body with frontmatter already stripped — the same string `startChar` indexes. */
  body: string;
  /** The fingerprint's headings, so section attribution agrees with the heading tree. */
  headings: ReadonlyArray<{ role: SectionRole | null; text: string; order: number }>;
  /** Bundle-relative paths, for internal-link detection. */
  bundlePaths: ReadonlySet<string>;
};

export function extractBlocks(input: BlockExtractInput): SkillBlock[] {
  const segments = segmentBody(input.body, { headings: input.headings });
  const headingTextByOrder = new Map(input.headings.map((h) => [h.order, h.text]));

  return segments.map((segment, index) => {
    const features = featuresOf(segment, input.bundlePaths);
    const context: RuleContext = {
      segment,
      previous: index > 0 ? segments[index - 1] : null,
      headingText:
        segment.parentHeadingOrder !== null
          ? (headingTextByOrder.get(segment.parentHeadingOrder) ?? "")
          : "",
      index,
      features,
    };

    const matched = RULES.find((rule) => rule.test(context)) ?? null;

    return {
      order: index,
      type: matched?.type ?? null,
      rule: matched?.rule ?? null,
      parentRole: segment.parentRole,
      parentHeadingOrder: segment.parentHeadingOrder,
      startChar: segment.startChar,
      endChar: segment.endChar,
      tokenEstimate: estimateTokens(segment),
      features,
    };
  });
}

/**
 * Per-type counts for the denormalised column on `skill_structures`.
 *
 * Mirrors why `sectionRoles` sits on that row beside the `headings` jsonb: mining asks
 * "does this structure carry a guardrail" over tens of thousands of rows, and answering it
 * by unnesting a child table on every query is the shape that made `/skills` take 2.3
 * seconds. The array is the indexable aggregation path; `skill_blocks` is the detail.
 *
 * Written in the same transaction as the block rows, so the two cannot disagree —
 * `verify:blocks` asserts they do not.
 */
export function blockCountsOf(blocks: readonly SkillBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of BLOCK_TYPES) {
    const n = blocks.filter((b) => b.type === type).length;
    if (n > 0) counts[type] = n;
  }
  const unclassified = blocks.filter((b) => b.type === null).length;
  if (unclassified > 0) counts.unclassified = unclassified;
  return counts;
}

export function blockTypesOf(blocks: readonly SkillBlock[]): BlockType[] {
  return [...new Set(blocks.map((b) => b.type).filter((t): t is BlockType => t !== null))].sort();
}
