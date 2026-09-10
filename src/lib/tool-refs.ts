/**
 * Tool references in a skill body (Doc 7 RD.6 — the measurement half, plan step P0).
 *
 * A skill tells an agent which tools to reach for: `gh`, `kubectl`, `psql`, a bundled script,
 * the agent's own built-ins through Claude Code's `allowed-tools` frontmatter. The corpus is
 * full of them and nothing indexes them — the `tool-contract` block knows a passage invokes
 * *something* and not what, and the capability-surface analyzer reads bundled *code*, never the
 * prose that tells an agent to run `git push --force`.
 *
 * ## This module measures. It does not know what a tool is.
 *
 * There is no vocabulary here, deliberately. Doc 7 §4 says the tool list is **seeded from a
 * corpus count, not from memory** — the way `SEED_REPOS` are verified against the GitHub API
 * rather than typed from recollection. So this module turns text into candidate tokens, the
 * extractor stores the counts, `pnpm structures --tools` prints the frequency table, and the
 * vocabulary (`src/lib/tools.ts`, step P1) is written from the head of that table with the long
 * tail left as *unrecognised* and counted. A token this module emits that no vocabulary entry
 * names is a fact about the corpus, not an error.
 *
 * ## Three sources, and only one of them is a command
 *
 * - **code** — the first token of each command line in a shell fence. This is the confident
 *   source: somebody wrote it to be run.
 * - **prose** — inline code spans. `` `gh pr view` `` is a command; `` `SKILL.md` `` and
 *   `` `userId` `` are not, and nothing about the backticks tells them apart. So a single-token
 *   span counts only when the same token also appears as a code-source token in the same
 *   document, or when the span is a multi-token command. A mention confirms usage; it does not
 *   establish it.
 * - **frontmatter** — `allowed-tools` (Claude Code's dialect). `Bash(git:*)` names two tools:
 *   the built-in and the command it is allowed to run.
 *
 * ## Written failure-first
 *
 * The naive reading — first word of every line inside every fence — types `then`, `fi`, `done`
 * and the output lines of a `console` transcript as tools, and a table headed by shell keywords
 * is a table nobody can curate from. `verify:tool-refs` asserts the naive reading still fires on
 * its fixture before asserting this module does not.
 *
 * A leaf module with no imports: the extractor (`server-only`), the probe and the verify script
 * all need one copy of these rules.
 */

export const TOOL_REF_SOURCES = ["code", "prose", "frontmatter"] as const;

export type ToolRefSource = (typeof TOOL_REF_SOURCES)[number];

export type ToolRef = {
  /** Lower-cased command name, or a bundle-relative script path. */
  token: string;
  source: ToolRefSource;
  /**
   * The line, span or frontmatter entry the token came from, trimmed. In memory only — the
   * stored column is the count — so a probe can print a dozen and a person can read them,
   * which is the only check a distribution cannot make for you.
   */
  excerpt: string;
};

/** `next 15`, `node@20`, `python 3.11`, `terraform >= 1.5` — a tool with a version beside it. */
export type VersionPin = {
  tool: string;
  version: string;
};

/**
 * Fence languages whose lines are commands. One list, imported by the block detector too, so the
 * detector's `tool-contract:shell-code` rule and this module cannot disagree about what a shell
 * fence is.
 */
export const SHELL_FENCE_LANGS = new Set([
  "bash", "sh", "zsh", "shell", "console", "terminal", "cmd", "bat", "powershell", "ps1", "fish",
]);

/** A leading prompt, which marks a line as typed rather than printed. */
const PROMPT = /^\s*(?:\$|>|❯|›|%|#\s*\$|PS>|PS [^>]*>|[A-Za-z]:\\[^>]*>)\s+/;

/**
 * The fence delimiter itself. A block's text runs from the opening ``` to the closing one, so
 * without this the first "command" of every bash fence is the word `bash` — measured on the
 * first probe at 585 references across 131 skills, heading the table. The probe exists for
 * exactly that: nothing in a fixture would have put a language tag at the top of the count.
 */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

/**
 * Control flow and pure builtins. Not tools: they appear in every non-trivial script and say
 * nothing about what the skill reaches for. Coreutils (`cat`, `rm`, `grep`) are deliberately
 * **not** here — `rm -rf` is a tool with a destructive flag, and RD.8 wants to see it.
 */
const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in",
  "function", "select", "return", "exit", "break", "continue", "export", "local", "declare",
  "typeset", "readonly", "set", "unset", "shift", "true", "false", "echo", "printf", "read",
  "source", "eval", "trap", "wait", "test", "alias", "unalias", "cd", "pushd", "popd", "dirs",
  "type", "hash", "ulimit", "umask", "let", "getopts", "builtin", "enable", "logout", "exec",
]);

/** Prefixes that run *another* command. Skipped so the real tool is the one counted. */
const WRAPPERS = new Set(["sudo", "doas", "time", "env", "nohup", "nice", "command", "exec", "watch"]);

/** `xargs rm` names two tools; the wrapper is counted *and* the argument is inspected. */
const PASS_THROUGH = new Set(["xargs"]);

/** A command name, after lower-casing. Paths are handled separately. */
const COMMAND_SHAPE = /^[a-z][a-z0-9_.+-]{0,23}$/;

/** A bundle-relative script: `./x.sh`, `scripts/x.py`, `bin/run`, `python tools/gen.mjs`. */
const SCRIPT_PATH = /^\.?\.?\/?(?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|mts|rb|pl|ps1|bat|cmd)$/i;
const LEADING_PATH = /^\.\//;

/** Split a line into pipeline / conjunction segments. Quotes are not honoured; this is a count. */
const SEGMENT_SPLIT = /\s*(?:\|\||&&|\||;)\s*/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function normaliseToken(raw: string): string | null {
  const stripped = raw.replace(/^[("'`]+|[)"'`,]+$/g, "");
  if (!stripped) return null;
  if (SCRIPT_PATH.test(stripped)) return stripped.replace(LEADING_PATH, "");
  const lower = stripped.toLowerCase();
  if (!COMMAND_SHAPE.test(lower)) return null;
  if (SHELL_KEYWORDS.has(lower)) return null;
  return lower;
}

/** The tool names one command line invokes — one per pipeline segment, wrappers skipped. */
export function commandTokens(line: string): string[] {
  const out: string[] = [];
  for (const segment of line.split(SEGMENT_SPLIT)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // `FOO=bar sudo env time cmd …` — walk past assignments and wrappers to the command.
    while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i].toLowerCase()))) i += 1;
    if (i >= words.length) continue;
    // `GET /api/users`, `EOF`, `NAME READY STATUS`: written in capitals, and no command is.
    if (/^[A-Z][A-Z0-9_-]+$/.test(words[i])) continue;
    const first = normaliseToken(words[i]);
    if (!first) continue;
    out.push(first);
    if (PASS_THROUGH.has(first) && words[i + 1]) {
      const next = normaliseToken(words[i + 1]);
      if (next) out.push(next);
    }
  }
  return out;
}

/**
 * Tool tokens in one code fence.
 *
 * Two rules keep a transcript from counting its own output. If **any** line carries a prompt,
 * only prompted lines are commands — the rest is what the command printed. And a fence whose
 * language is not a shell is skipped unless it carries prompts, because the first token of a
 * Python fence is `import` and of a YAML fence is a key.
 */
export function codeToolTokens(text: string, language: string | null): string[] {
  const lang = (language ?? "").toLowerCase();
  const lines = text.split(/\r?\n/);
  const hasPrompt = lines.some((l) => PROMPT.test(l));
  if (!hasPrompt && lang && !SHELL_FENCE_LANGS.has(lang)) return [];
  if (!hasPrompt && !lang) return [];

  const out: string[] = [];
  for (const body of commandLines(lines, hasPrompt)) out.push(...commandTokens(body));
  return out;
}

/**
 * A here-document opener. Everything up to the terminator is data handed to the command, not
 * commands — the second probe put `eof` (39 references), `import` (47) and `def` at the top of
 * the code column, all from `python3 - <<EOF` bodies.
 */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/;

/** The command lines of a fence: prompts stripped; delimiters, comments, heredocs and output removed. */
function commandLines(lines: string[], hasPrompt: boolean): string[] {
  const out: string[] = [];
  let continued = false;
  let heredocEnd: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    if (FENCE_LINE.test(line)) continue;
    const wasContinued = continued;
    continued = /\\\s*$/.test(line);
    if (wasContinued) continue;
    if (hasPrompt && !PROMPT.test(line)) continue;
    const body = line.replace(PROMPT, "").trim();
    if (!body || body.startsWith("#")) continue;
    const heredoc = body.match(HEREDOC);
    if (heredoc) heredocEnd = heredoc[2];
    out.push(body);
  }
  return out;
}

/** Code tokens with the line each came from, for the probe's samples. */
export function codeToolRefs(text: string, language: string | null): ToolRef[] {
  const lang = (language ?? "").toLowerCase();
  const lines = text.split(/\r?\n/);
  const hasPrompt = lines.some((l) => PROMPT.test(l));
  if (!hasPrompt && lang && !SHELL_FENCE_LANGS.has(lang)) return [];
  if (!hasPrompt && !lang) return [];
  const out: ToolRef[] = [];
  for (const body of commandLines(lines, hasPrompt)) {
    for (const token of commandTokens(body)) out.push({ token, source: "code", excerpt: body.slice(0, 120) });
  }
  return out;
}

/** Inline code spans, with the span text. Fenced code is not inline and is excluded by shape. */
const INLINE_CODE = /`([^`\n]{1,120})`/g;

/**
 * What a multi-token inline span has to look like to be read as a command: argv. Every word a
 * flag, a path, a subcommand or a value — no `=`, no brackets, no trailing colon. `const x = 1`,
 * `import x from y`, `where id = 1` and `{ a: 1 }` all fail this; `gh pr view 12 --json title`
 * passes. The first probe found `post`, `get`, `const`, `await` and `where` in the top sixty
 * from spans exactly like those.
 */
const ARGV_WORD = /^(?:-{1,2}[\w][\w.:=/-]*|[\w][\w./@:*~+,-]*)$/;

/** Words that open a code snippet or a sentence, never a command. */
const NOT_A_COMMAND = new Set([
  "const", "let", "var", "import", "from", "export", "await", "async", "return", "function",
  "class", "def", "print", "select", "insert", "update", "where", "create", "drop", "alter",
  "new", "this", "null", "undefined", "true", "false", "if", "else", "for", "while", "try",
  "catch", "the", "a", "an", "no", "not", "and", "or", "to", "of", "in", "on", "with", "is",
  "are", "be", "use", "see", "run", "runs", "e.g", "i.e", "etc", "via", "as", "at", "by", "it",
  "its", "your", "our", "my", "any", "all", "each", "only", "then", "when", "how", "what",
]);

/**
 * Candidate tokens from prose: every inline code span read as a command line.
 *
 * Returns *candidates* — the confirmation rule (a single-token span needs a code-source sibling
 * in the same document) is applied in `extractToolRefs`, because it needs the whole document. A
 * multi-token span stands alone only when it is argv-shaped and its first word is not written in
 * capitals: `POST /api/users` is an HTTP method, and the normaliser would otherwise lower-case it
 * into a plausible command.
 */
export function proseToolCandidates(
  text: string,
): Array<{ token: string; multiToken: boolean; excerpt: string }> {
  const out: Array<{ token: string; multiToken: boolean; excerpt: string }> = [];
  for (const match of text.matchAll(INLINE_CODE)) {
    const span = match[1].trim();
    if (!span || ASSIGNMENT.test(span)) continue;
    const words = span.split(/\s+/);
    const tokens = commandTokens(span);
    if (tokens.length === 0) continue;
    const token = tokens[0];
    if (NOT_A_COMMAND.has(token)) continue;
    const argvShaped = words.every((w) => ARGV_WORD.test(w));
    const isPath = /^[\w.-]+\/[\w./-]+$/.test(span);
    /*
     * An English phrase in backticks — `failed to fetch`, `the value` — is argv-shaped too. What
     * separates a command from a phrase is an *argument*: a flag, a path, a package spec, a file.
     * A bare three-word command alone in prose therefore does not stand on its own; it counts
     * once the document invokes the tool anywhere else, which is the confirmation rule's job.
     */
    const hasArgument = words.slice(1).some((w) => /^-|[/@]|\.[a-z]{1,5}$/.test(w));
    out.push({ token, multiToken: words.length > 1 && argvShaped && hasArgument && !isPath, excerpt: span });
  }
  return out;
}

const ALLOWED_TOOLS_KEYS = ["allowed-tools", "allowedTools", "allowed_tools", "tools"];

/**
 * `allowed-tools` from a Claude Code skill's frontmatter, as tool tokens.
 *
 * Accepts the string form (`Bash(git:*) Read Edit`, `Bash(npm run *), Grep`) and the list form.
 * `Bash(git:*)` yields both `bash` and `git`: the built-in is a tool and so is what it is
 * allowed to run. MCP tools (`mcp__server__tool`) yield `mcp:server`.
 */
export function allowedToolsOf(frontmatter: Record<string, unknown>): string[] {
  let raw: unknown = undefined;
  for (const key of ALLOWED_TOOLS_KEYS) {
    if (frontmatter[key] !== undefined) {
      raw = frontmatter[key];
      break;
    }
  }
  if (raw === undefined || raw === null) return [];

  const entries: string[] = [];
  const pushSplit = (s: string) => {
    // Split on commas and whitespace that sit *outside* parentheses.
    let depth = 0;
    let current = "";
    for (const ch of s) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && /[\s,]/.test(ch)) {
        if (current) entries.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) entries.push(current);
  };
  if (typeof raw === "string") pushSplit(raw);
  else if (Array.isArray(raw)) for (const item of raw) if (typeof item === "string") pushSplit(item);
  else return [];

  const out = new Set<string>();
  for (const entry of entries) {
    const m = entry.match(/^([A-Za-z_][\w-]*)(?:\((.*)\))?$/);
    if (!m) continue;
    const name = m[1];
    const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
    if (mcp) {
      out.add(`mcp:${mcp[1].toLowerCase()}`);
      continue;
    }
    out.add(name.toLowerCase());
    if (m[2]) {
      // `git:*`, `npm run *`, `git commit:*, git push:*` — the command is the first word of
      // each comma-separated spec, before any `:`.
      for (const spec of m[2].split(",")) {
        const first = spec.trim().split(/[\s:]/)[0];
        const token = first ? normaliseToken(first) : null;
        if (token && token !== "*") out.add(token);
      }
    }
  }
  return [...out].sort();
}

/**
 * Version pins in prose: a tool named with a version beside it.
 *
 * The roughest of the three detectors and named as such — it exists so RD.10 has something to
 * measure against release feeds, and `pnpm structures --tools` prints what it finds so the
 * noise is visible before anything is built on it. Four shapes: `node@20`, `python 3.11`
 * (dotted), `terraform >= 1.5` (comparator), and `Next.js 15` / `Node 18` (a name and a bare
 * integer).
 *
 * The last shape is where the noise lives. The first probe's top pins were `workflow 1`,
 * `practices 1`, `pattern 3` — numbered headings — and an exclusion list cannot keep up with
 * English. So a bare-integer pin counts only when the name is **confirmed**: it also appears as
 * a tool token in the same document, or carries a `.js` suffix that only a framework would. The
 * same rule prose mentions live under, for the same reason.
 */
const PIN_AT = /\b([a-z][a-z0-9+-]{1,20})@v?(\d{1,3}(?:\.\d{1,4}){0,3})\b/gi;
const PIN_DOTTED = /\b([A-Za-z][A-Za-z0-9+-]{1,20}(?:\.js)?)\s+v?(\d{1,3}(?:\.\d{1,4}){1,3})\b/g;
const PIN_COMPARATOR = /\b([A-Za-z][A-Za-z0-9+-]{1,20}(?:\.js)?)\s*(?:>=|<=|~>|\^|>|<|==)\s*v?(\d{1,3}(?:\.\d{1,4}){0,3})\b/g;
const PIN_BARE = /\b([A-Za-z][A-Za-z0-9+-]{1,15}(?:\.js)?)\s+v?(\d{1,3})\b/g;

/** Inline code, removed before pins are read: `sleep 5` and `return 1.0` are code, not pins. */
const INLINE_CODE_ANY = /`[^`\n]*`/g;

const NOT_A_TOOL = new Set([
  "aed", "eur", "usd", "gbp", "chf", "jpy", "skill", "skills", "agent", "agents", "model",
  "step", "steps", "phase", "part", "chapter", "section", "version", "option", "example",
  "table", "figure", "level", "tier", "page", "line", "item", "rule", "task", "day", "week",
  "round", "stage", "case", "type", "test", "note", "tip", "top", "issue", "pr", "sprint",
  "iteration", "attempt", "wave", "milestone", "priority", "severity", "score", "grade", "year",
  "month", "hour", "minute", "second", "the", "and", "for", "with", "than", "to", "of", "at",
  "in", "on", "by", "or", "a", "an", "http", "https", "port", "ip", "id", "no", "yes",
]);

/**
 * `text` is **prose** — the caller hands over non-code segments, and inline code is stripped
 * here — because a version inside a fence is an argument (`sleep 5`, `return 1.0`), not a pin.
 *
 * `@` and a comparator are strong enough syntax to stand alone. A dotted version or a bare
 * integer beside a word needs the word to be **confirmed** (a tool this document invokes) or
 * **named like a tool** — capitalised (`Python 3.11`, `Node 18`) or `.js`-suffixed — because
 * `is 0.2`, `all 3.0` and `workflow 1` are English with a number after it.
 */
export function versionPinsOf(text: string, confirmed: ReadonlySet<string> = new Set()): VersionPin[] {
  const prose = text.replace(INLINE_CODE_ANY, " ");
  const seen = new Set<string>();
  const out: VersionPin[] = [];
  const push = (tool: string, version: string) => {
    const name = tool.toLowerCase().replace(/\.js$/, "");
    if (NOT_A_TOOL.has(name) || name.length < 2) return;
    const key = `${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ tool: name, version });
  };
  /*
   * A capital letter mid-sentence names something; at a sentence or list start it is grammar.
   * `Python 3.11 is required` and `requires Python 3.11` both keep the pin; `But 4 of them` and
   * `Have 5 minutes` — the third probe's pins — do not.
   */
  const midSentence = (index: number) => {
    const before = prose.slice(Math.max(0, index - 3), index).trimEnd();
    return before.length > 0 && !/[.!?:;|#*>-]$/.test(before);
  };
  const namedLikeATool = (raw: string, index: number) =>
    /\.js$/i.test(raw) ||
    (/^[A-Z]/.test(raw) && midSentence(index)) ||
    confirmed.has(raw.toLowerCase().replace(/\.js$/, ""));

  for (const m of prose.matchAll(PIN_AT)) push(m[1], m[2]);
  for (const m of prose.matchAll(PIN_COMPARATOR)) push(m[1], m[2]);
  for (const m of prose.matchAll(PIN_DOTTED)) if (namedLikeATool(m[1], m.index ?? 0)) push(m[1], m[2]);
  for (const m of prose.matchAll(PIN_BARE)) {
    const framework = /\.js$/i.test(m[1]);
    const name = m[1].toLowerCase().replace(/\.js$/, "");
    // `Read 2 files`: a confirmed tool whose name is an English verb is not being versioned.
    if (framework || (confirmed.has(name) && !GENERIC_WORD_TOOLS.has(name))) push(m[1], m[2]);
  }
  return out;
}

/** Tools named with ordinary English words. Real tools, never version-pinned by a bare integer. */
const GENERIC_WORD_TOOLS = new Set([
  "read", "write", "edit", "open", "find", "head", "tail", "sleep", "touch", "cut", "sort", "test",
  "time", "watch", "less", "more", "look", "make", "task", "just", "go", "agent", "use", "get",
  "set", "add", "run", "cat", "tr", "wc", "tee", "sed", "awk", "grep", "ls", "cp", "mv", "rm",
]);

export type ToolRefSegment = {
  kind: "code" | "prose";
  /** Fence language for a code segment; ignored for prose. */
  language: string | null;
  text: string;
};

export type ToolRefReport = {
  /** Every reference, one per occurrence, with where it came from. */
  refs: ToolRef[];
  /** `{ gh: 3, git: 5 }` — the stored shape. Counts across all three sources. */
  counts: Record<string, number>;
  /** The frontmatter list, kept apart because RD.8 compares it against the other two. */
  allowedTools: string[];
};

/**
 * Tool references for one document, with the prose confirmation rule applied.
 *
 * Segments are the block detector's own segmentation — the caller hands over `(kind, language,
 * text)` per block so this module never re-segments a body and cannot disagree with the blocks
 * about where a fence begins.
 */
export function extractToolRefs(input: {
  segments: ToolRefSegment[];
  frontmatter: Record<string, unknown>;
}): ToolRefReport {
  const refs: ToolRef[] = [];
  const fromCode = new Set<string>();

  for (const segment of input.segments) {
    if (segment.kind !== "code") continue;
    for (const ref of codeToolRefs(segment.text, segment.language)) {
      refs.push(ref);
      fromCode.add(ref.token);
    }
  }

  const allowedTools = allowedToolsOf(input.frontmatter);
  for (const token of allowedTools) refs.push({ token, source: "frontmatter", excerpt: "allowed-tools" });
  const confirmed = new Set([...fromCode, ...allowedTools]);

  for (const segment of input.segments) {
    if (segment.kind !== "prose") continue;
    for (const candidate of proseToolCandidates(segment.text)) {
      if (candidate.multiToken || confirmed.has(candidate.token)) {
        refs.push({ token: candidate.token, source: "prose", excerpt: candidate.excerpt });
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const ref of refs) counts[ref.token] = (counts[ref.token] ?? 0) + 1;

  return { refs, counts, allowedTools };
}
