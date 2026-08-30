import "server-only";

import type { BundleFile } from "@/server/storage";

/**
 * Structural fingerprint extraction (Doc 2 R3.2).
 *
 * Turns one skill bundle into the row `skill_structures` stores. Pure: no network, no
 * model, no database — the same bundle always yields the same fingerprint, which is what
 * makes re-extraction free and archetype output traceable back to evidence (R7.2).
 *
 * The heading roles are the load-bearing part. A raw heading string is not aggregable —
 * "When to use this", "When to use this skill", "## Use cases" and "Triggers" are four
 * strings and one idea, and an archetype built on strings would report four sections at
 * 25% each instead of one at 100%. So headings are normalised to a small closed set of
 * **roles**, and the archetype is stated in roles.
 *
 * Rules first, deliberately. A rule is free, explainable and reproducible; the LLM pass
 * (`classifyHeadings`) exists only for the strings the rules do not recognise, runs once
 * per distinct heading rather than once per skill, and caches. On this corpus the rules
 * already cover most of the mass, so the model is a tail-filler and not a dependency.
 */

export const EXTRACTOR_VERSION = "1.1.0";

/**
 * The closed set of section roles.
 *
 * Small on purpose: these are the moves a skill document makes, not the topics it covers.
 * A role earns its place only if an archetype would say something different about a skill
 * that has it versus one that does not.
 */
export const SECTION_ROLES = [
  /** What this is and what it is for. */
  "purpose",
  /** The triggering contract — when the agent should reach for this. */
  "when-to-use",
  /** What must be true or installed first. */
  "prerequisites",
  /** Mechanism: how the thing works, conceptually. */
  "how-it-works",
  /** The ordered procedure the agent follows. */
  "steps",
  /** Constraints, policies, must/never rules. */
  "rules",
  /** Worked examples, sample input and output. */
  "examples",
  /** What the skill needs handed to it before it can run. */
  "inputs",
  /** The shape the answer must take. */
  "output-format",
  /** Pointers to bundled files or external material. */
  "references",
  /** What to do when it goes wrong. */
  "troubleshooting",
  /** Known bounds, non-goals, failure cases. */
  "limitations",
  /** Options, settings, parameters. */
  "configuration",
  /** Recognised as a heading, not as one of the above. */
  "other",
] as const;

export type SectionRole = (typeof SECTION_ROLES)[number];

/**
 * Heading text → role.
 *
 * Ordered: the first match wins, so the more specific pattern is listed first. Matched
 * against the heading lowercased with punctuation stripped.
 */
const ROLE_RULES: ReadonlyArray<{ role: SectionRole; pattern: RegExp }> = [
  {
    role: "when-to-use",
    pattern:
      /\b(when to use|when not to use|when should|use (this|it) when|use cases?|triggers?|activation|applicability|scope|when this applies)\b/,
  },
  {
    role: "inputs",
    pattern:
      /\b(inputs?|required inputs?|what (you|i) need|information needed|data needed|context needed|gather(ing)? (the )?(input|information|context))\b/,
  },
  {
    role: "output-format",
    pattern:
      /\b(outputs?|output format|response format|deliverables?|report format|result format|format of|returns?|schema|produces|what (this|it) (skill )?(produces|returns|outputs)|artifacts?)\b/,
  },
  {
    role: "steps",
    pattern:
      /\b(steps?|workflow|process|procedure|instructions?|how to|usage|running|execution|the loop|walkthrough|quick ?start|getting started|implementation|common tasks?)\b/,
  },
  {
    role: "rules",
    pattern:
      /\b(rules?|guidelines?|principles?|constraints?|requirements?|standards?|conventions?|policy|policies|do(s)? and don'?t(s)?|best practices?|check ?lists?|criteria|quality (checks?|gates?|bar)|validation|verification|acceptance)\b/,
  },
  {
    role: "examples",
    pattern: /\b(examples?|samples?|demo|for instance|case study|case studies|snippets?|recipes?)\b/,
  },
  {
    role: "troubleshooting",
    pattern:
      /\b(troubleshoot\w*|debugging|common (errors?|issues?|problems?|mistakes?|pitfalls?)|errors?|faq|gotchas?|known issues?|if (it|this) fails)\b/,
  },
  {
    role: "limitations",
    pattern:
      /\b(limitations?|non-?goals?|out of scope|caveats?|restrictions?|what (this|it) (does not|doesn'?t) do|not supported|anti-?patterns?)\b/,
  },
  {
    role: "prerequisites",
    pattern:
      /\b(prerequisites?|requirements? before|before (you )?(start\w*|begin\w*|running)|setup|set up|installation|install|dependencies|environment)\b/,
  },
  {
    role: "configuration",
    pattern:
      /\b(config\w*|options?|settings?|parameters?|arguments?|flags?|variables?|customi[sz]ation|tuning)\b/,
  },
  {
    role: "references",
    pattern:
      /\b(references?|resources?|further reading|see also|links?|appendix|related|documentation|docs|bundled files?|files? in this skill)\b/,
  },
  {
    role: "how-it-works",
    pattern:
      /\b(how it works|anatomy|architecture|design|mechanism|under the hood|internals?|background|context|concepts?|theory|approach|strategy|model)\b/,
  },
  {
    role: "purpose",
    pattern:
      /\b(purpose|overview|introduction|intro|about|summary|what (is|this|it) (is|does)|description|goals?|objectives?)\b/,
  },
];

/** Lowercased, punctuation and markdown decoration stripped, whitespace collapsed. */
function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The rule pass. Returns `null` — not `"other"` — when nothing matches, so the caller can
 * tell "no rule knew this" from "a rule decided it is miscellaneous". Only the former is
 * worth spending a model call on.
 */
export function roleFromRules(headingText: string): SectionRole | null {
  const normalized = normalizeHeading(headingText);
  if (normalized.length === 0) return null;
  for (const { role, pattern } of ROLE_RULES) {
    if (pattern.test(normalized)) return role;
  }
  return null;
}

export type HeadingNode = {
  depth: number;
  /** Trimmed heading text, capped. Not body content — a label. */
  text: string;
  role: SectionRole | null;
  order: number;
};

export type DescriptionShape = {
  /** Description opens with an imperative verb — the shape that triggers well (R2.8). */
  startsWithVerb: boolean;
  /** Carries an explicit "use when …" trigger clause. */
  hasUseWhen: boolean;
  /** Names concrete artifacts or tools rather than only adjectives. */
  hasConcreteNoun: boolean;
  sentenceCount: number;
  wordCount: number;
};

export type StructureFingerprint = {
  extractorVersion: string;
  headings: HeadingNode[];
  sectionRoles: SectionRole[];
  headingCount: number;
  maxHeadingDepth: number;
  bodyBytes: number;
  wordCount: number;
  codeBlockCount: number;
  codeLanguages: string[];
  listItemCount: number;
  tableCount: number;
  proseRatio: number;
  linkCount: number;
  internalLinkCount: number;
  brokenLinkCount: number;
  fileCount: number;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  hasTemplates: boolean;
  resourceDirs: string[];
  fileExtensions: string[];
  frontmatterKeys: string[];
  descriptionLength: number;
  descriptionShape: DescriptionShape;
  /** Heading strings no rule recognised — the only input the LLM pass needs. */
  unresolvedHeadings: string[];
};

/** Verbs that open a well-formed skill description. Not exhaustive; a signal, not a gate. */
const IMPERATIVE_OPENERS =
  /^(use|create|generate|build|write|review|analy[sz]e|extract|convert|transform|validate|check|run|deploy|manage|automate|fetch|query|search|summari[sz]e|translate|format|lint|test|debug|refactor|scaffold|plan|design|draft|audit|monitor|track|send|read|parse|render|export|import|sync|configure|set|install|add|apply|compare|evaluate|explain|guide|help|find|list|update|migrate|optimi[sz]e|clean|process|handle|integrate|connect|orchestrate|coordinate|capture|record|publish|schedule)\b/;

const USE_WHEN =
  /\b(use (this|it|when)|invoke when|trigger(s|ed)? (when|on)|when (the )?(user|you|asked|working|building|creating|the task)|for when|apply when|call this when|reach for)\b/i;

const CONCRETE_NOUN =
  /\b(file|files|repo|repository|api|json|yaml|csv|markdown|md|pdf|html|css|sql|database|db|table|component|function|class|module|script|test|tests|commit|branch|pull request|pr|issue|ticket|endpoint|schema|config|log|logs|image|video|audio|document|spreadsheet|email|url|token|package|container|docker|kubernetes|terraform|react|python|typescript|javascript|go|rust|java)\b/i;

function describeDescription(description: string): DescriptionShape {
  const trimmed = description.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  return {
    startsWithVerb: IMPERATIVE_OPENERS.test(trimmed.toLowerCase()),
    hasUseWhen: USE_WHEN.test(trimmed),
    hasConcreteNoun: CONCRETE_NOUN.test(trimmed),
    sentenceCount: trimmed ? trimmed.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length : 0,
    wordCount: words.length,
  };
}

/** Top-level directory of a bundle-relative path, or `null` for a file at the root. */
function topDir(path: string): string | null {
  const normalized = path.replace(/^\.\//, "");
  const slash = normalized.indexOf("/");
  return slash > 0 ? normalized.slice(0, slash).toLowerCase() : null;
}

function extensionOf(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

export type ExtractInput = {
  files: BundleFile[];
  /** Marker body with frontmatter already stripped. */
  body: string;
  frontmatter: Record<string, unknown>;
  markerPath: string;
};

export function extractStructure(input: ExtractInput): StructureFingerprint {
  const { body, frontmatter, files, markerPath } = input;
  const lines = body.split(/\r?\n/);

  const headings: HeadingNode[] = [];
  const codeLanguages = new Set<string>();
  let codeBlockCount = 0;
  let listItemCount = 0;
  let tableCount = 0;
  let proseLines = 0;
  let contentLines = 0;

  let inFence = false;
  let fenceMarker = "";
  let previousWasTableRow = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Fences first: everything inside one is code, not prose, not a heading.
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
        codeBlockCount += 1;
        const lang = fence[2].trim().split(/\s+/)[0]?.toLowerCase();
        if (lang && /^[a-z0-9+#._-]{1,20}$/.test(lang)) codeLanguages.add(lang);
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    if (trimmed.length === 0) {
      previousWasTableRow = false;
      continue;
    }
    contentLines += 1;

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const text = heading[2].trim().slice(0, 200);
      headings.push({
        depth: heading[1].length,
        text,
        role: roleFromRules(text),
        order: headings.length,
      });
      previousWasTableRow = false;
      continue;
    }

    // A table row is `| … |`; a new table starts when the previous line was not one.
    if (/^\|.*\|$/.test(trimmed)) {
      if (!previousWasTableRow) tableCount += 1;
      previousWasTableRow = true;
      continue;
    }
    previousWasTableRow = false;

    if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
      listItemCount += 1;
      continue;
    }

    proseLines += 1;
  }

  // Links: markdown inline links only. A bare URL is not a disclosure decision.
  const linkMatches = [...body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)];
  const bundlePaths = new Set(files.map((f) => f.path.replace(/^\.\//, "")));
  const markerDir = markerPath.includes("/")
    ? markerPath.slice(0, markerPath.lastIndexOf("/"))
    : "";

  let internalLinkCount = 0;
  let brokenLinkCount = 0;
  for (const match of linkMatches) {
    const target = match[1];
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue; // external or anchor
    internalLinkCount += 1;

    const withoutAnchor = target.split("#")[0].replace(/^\.\//, "");
    if (withoutAnchor.length === 0) continue;
    // Resolve relative to the marker, then also accept a bundle-root-relative hit —
    // both spellings appear in the corpus and neither is wrong.
    const resolved = markerDir ? `${markerDir}/${withoutAnchor}` : withoutAnchor;
    const hit =
      bundlePaths.has(resolved) ||
      bundlePaths.has(withoutAnchor) ||
      [...bundlePaths].some((p) => p.endsWith(`/${withoutAnchor}`));
    if (!hit) brokenLinkCount += 1;
  }

  const dirs = new Set<string>();
  const extensions = new Set<string>();
  for (const file of files) {
    const dir = topDir(file.path);
    if (dir) dirs.add(dir);
    const ext = extensionOf(file.path);
    if (ext) extensions.add(ext);
  }

  const sectionRoles = [
    ...new Set(headings.map((h) => h.role).filter((r): r is SectionRole => r !== null)),
  ];

  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : "";

  return {
    extractorVersion: EXTRACTOR_VERSION,
    headings,
    sectionRoles,
    headingCount: headings.length,
    maxHeadingDepth: headings.reduce((max, h) => Math.max(max, h.depth), 0),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    wordCount: body.split(/\s+/).filter(Boolean).length,
    codeBlockCount,
    codeLanguages: [...codeLanguages].sort(),
    listItemCount,
    tableCount,
    // Whole percent. Enough resolution to band skills; no false precision.
    proseRatio: contentLines > 0 ? Math.round((proseLines / contentLines) * 100) : 0,
    linkCount: linkMatches.length,
    internalLinkCount,
    brokenLinkCount,
    fileCount: files.length,
    hasScripts: dirs.has("scripts") || dirs.has("bin") || dirs.has("src"),
    hasReferences: dirs.has("references") || dirs.has("reference") || dirs.has("docs"),
    hasAssets: dirs.has("assets") || dirs.has("images") || dirs.has("static"),
    hasTemplates: dirs.has("templates") || dirs.has("template"),
    resourceDirs: [...dirs].sort(),
    fileExtensions: [...extensions].sort(),
    frontmatterKeys: Object.keys(frontmatter).sort(),
    descriptionLength: description.length,
    descriptionShape: describeDescription(description),
    unresolvedHeadings: [
      ...new Set(headings.filter((h) => h.role === null).map((h) => h.text)),
    ],
  };
}
