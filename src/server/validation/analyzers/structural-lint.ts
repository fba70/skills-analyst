import "server-only";

import type { Analyzer, Finding } from "../types";

/**
 * Structural lint (Doc 2 R2.7, R2.8).
 *
 * Quality, not security — so almost everything here is a `warn`. The two exceptions are
 * `name` and `description`: without them a skill has no identity and no trigger, so it
 * cannot be listed or matched, and serving it would be serving nothing.
 */

const MAX_BODY_BYTES = 40_000;
const DISCLOSURE_HINT_BYTES = 15_000;
const MIN_DESCRIPTION = 40;
const MAX_DESCRIPTION = 1024;

/** The exact string `splitFrontmatter` uses when there is no `---` block at all. */
const NO_FRONTMATTER_BLOCK = "no frontmatter block";

/** Vague words that make a description trigger badly (R2.8). */
const VAGUE_TERMS =
  /\b(various|stuff|things|etc|powerful|amazing|awesome|best|ultimate|simply|easy)\b/gi;

export const structuralLint: Analyzer = {
  name: "structural-lint",
  /**
   * 1.1.0 — identity checks became dialect-aware.
   * 1.2.0 — malformed frontmatter separated from absent frontmatter.
   * 1.3.0 — derivable identity warns instead of blocking.
   * 1.4.0 — **no rule change here.** The quality score this analyzer's `bodyBytes` feeds
   *         became a composite rather than an inverted defect count, so every verdict needs
   *         re-scoring. Bumped deliberately: the re-scan selector is the analyzer version,
   *         and a scoring change that leaves the corpus un-rescored is exactly the silent
   *         drift R2.12 exists to prevent. A dedicated scorer version would be more precise
   *         and is worth having once scoring changes more often than rules do.
   */
  version: "1.5.0",

  run({ files, body, frontmatter, markerPath, dialect, resolvedName, resolvedSummary, parseError }) {

    const findings: Finding[] = [];

    /**
     * A description that is only a path is a symlink we read as a document.
     *
     * Git stores a symlink as a blob whose *content is the target path*, and over
     * raw.githubusercontent.com that is literally what comes back —
     * `../../../skills/docs-auditor/SKILL.md`. `isSymlink` filters these at enumeration
     * now, but 101 indexed skills predate that filter and are still served: listed,
     * searched, ranked, and downloadable, with a file path where their description should
     * be.
     *
     * Blocking, because this is the one identity question that blocks — nothing describes
     * the skill, and nothing can decide when it should trigger. The taxonomy already refuses
     * to classify them (`classifiable.ts`), which stopped us *paying* for them; it did not
     * stop us serving them, and those are different problems with different fixes.
     *
     * Anchored at both ends with no whitespace allowed, so it cannot catch prose: every real
     * description contains a space.
     */
    const summaryText = (resolvedSummary ?? "").trim();
    if (summaryText.length > 0 && /^[A-Za-z0-9_./-]+$/.test(summaryText) && summaryText.includes("/")) {
      findings.push({
        reason: "description-is-a-path",
        severity: "high",
        message:
          `The description is a file path (\`${summaryText}\`), not a description — almost ` +
          `always a git symlink read as a document, whose stored content is its target path.`,
        file: markerPath,
      });
    }
    const bodyBytes = Buffer.byteLength(body, "utf8");

    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

    /**
     * Does this dialect declare its identity in frontmatter?
     *
     * Only the SKILL.md family does. An AGENTS.md is plain markdown by specification — it
     * has no frontmatter block at all — and a `.cursor/rules` file follows its own
     * conventions. Applying the SKILL.md contract to them quarantined **every** AGENTS.md
     * in the corpus: 121 of 121, all for `missing-name` and `missing-description`, both of
     * which are blocking. The files were fine; the rule was wrong about what they are.
     *
     * The normalizer already resolves identity per dialect — frontmatter, then the leading
     * heading, then the directory name — and it did so correctly all along, producing names
     * like "Agent Configuration — Contributor Rules". So the question to ask is whether the
     * skill *has* a name, and only for frontmatter dialects is that the same as whether a
     * YAML key exists.
     */
    const usesFrontmatter = dialect === "anthropic_skill" || dialect === "claude_plugin";

    if (!usesFrontmatter) {
      // Identity still has to come from somewhere. Falling back to a directory name is
      // acceptable; having nothing at all is not, because there would be nothing to list.
      if (!resolvedName || resolvedName.trim().length === 0) {
        findings.push({
          reason: "missing-name",
          severity: "high",
          message:
            "No name could be derived — no frontmatter, no leading heading, no directory name.",
          file: markerPath,
        });
      }

      if (bodyBytes === 0) {
        findings.push({
          reason: "empty-document",
          severity: "high",
          message: "The document is empty.",
          file: markerPath,
        });
      }

      // A missing summary is worth noting and must not block: an AGENTS.md is a set of
      // instructions for an agent already in the repository, not a skill that has to be
      // matched and triggered from a description.
      if (!resolvedSummary || resolvedSummary.trim().length === 0) {
        findings.push({
          reason: "no-summary",
          severity: "low",
          message:
            "No summary could be derived from the opening paragraph. It will list with a name only.",
          file: markerPath,
        });
      }

    }

    // Frontmatter identity, for the dialects that declare it there. Everything after this
    // block — size, progressive disclosure, links, orphans — applies to every dialect and
    // must not be skipped, which is why this is a guard rather than an early return.
    /**
     * A frontmatter block that failed to parse is a different fault from one that is
     * absent, and saying so is the whole value of the finding.
     *
     * These reported `missing-name` + `missing-description`, which sends an author looking
     * for fields that are right there in their file. The real cause is almost always a
     * colon inside an unquoted value — `description: Digest of posts on [REPLACE: TOPIC]`
     * makes YAML read `[REPLACE: TOPIC]` as a nested mapping and reject the document. One
     * pair of quotes fixes it, and nothing in the old verdict pointed there.
     */
    // `NO_BLOCK` is absence, not malformation: a SKILL.md with no `---` block at all is
    // missing its identity and should say so. Only a block that exists and failed to parse
    // gets the parse-error verdict.
    const malformed =
      Boolean(parseError) && parseError !== NO_FRONTMATTER_BLOCK && name.length === 0;

    /**
     * Can this skill be identified at all, however it declares itself?
     *
     * The normalizer's fallback chain — frontmatter, then the leading heading, then the
     * directory name — has already answered this. A SKILL.md written with `# Title` and a
     * `## Description` section instead of a YAML block is a real skill with a real name;
     * it simply does not follow the convention.
     */
    const identified = Boolean(resolvedName && resolvedName.trim().length > 0);
    /** Did the author write a `---` block at all? Absent and incomplete read differently. */
    const hasFrontmatterBlock = parseError !== NO_FRONTMATTER_BLOCK;

    if (usesFrontmatter && malformed) {
      findings.push({
        reason: "invalid-frontmatter",
        severity: "high",
        message: `Frontmatter could not be parsed: ${parseError}. Quoting values that contain a colon is the usual fix.`,
        file: markerPath,
      });
    } else if (usesFrontmatter && name.length === 0 && identified && !hasFrontmatterBlock) {
      /**
       * A SKILL.md with no frontmatter block, but a name we could derive.
       *
       * This used to block, and blocking was the wrong call. Twenty-eight of these are real
       * skills that write `# Title` and `## Description` headings instead of YAML — content
       * we had fetched, hashed and judged, then hidden from the registry over a convention.
       * The trust boundary is about *safety*, and a missing YAML block is not a safety
       * question; every security analyzer still ran and still passed.
       *
       * It is a genuine quality defect, though, and stays visible as one. `description` is
       * what a consuming agent matches on in the Agent Skills standard, so a skill without
       * it triggers less reliably no matter how good its prose. Two `medium` findings cost
       * 16 quality points, which ranks these below well-formed skills without pretending
       * they do not exist.
       */
      findings.push({
        reason: "frontmatter-absent",
        severity: "medium",
        message: `No YAML frontmatter block. The name was derived from the document ("${resolvedName}"), but most tooling reads it from frontmatter.`,
        file: markerPath,
      });
    } else if (usesFrontmatter && name.length === 0) {
      // A block that exists and omits `name` is a different message from no block at all —
      // telling an author their frontmatter is missing when it is right there sends them
      // looking in the wrong place. Same severity rule either way: blocking only when
      // nothing anywhere identifies the skill.
      findings.push({
        reason: "missing-name",
        severity: identified ? "medium" : "high",
        message: identified
          ? `Frontmatter has no \`name\`; it was derived from the document ("${resolvedName}"). Most tooling reads the name from frontmatter.`
          : "No frontmatter `name`, and no heading or directory name to fall back on. The skill has no identity to match on.",
        file: markerPath,
      });
    } else if (usesFrontmatter && name.length > 0 && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      findings.push({
        reason: "name-not-kebab-case",
        severity: "low",
        message: `\`name: ${name}\` is not lowercase-kebab-case, which most tooling assumes.`,
        file: markerPath,
      });
    }

    if (usesFrontmatter && !malformed && description.length === 0) {
      // Blocking only when nothing describes the skill at all. A derived summary is worse
      // than a written `description` — it was not composed to be matched against — but it
      // is not nothing, and it is what the registry lists the skill by.
      const derived = Boolean(resolvedSummary && resolvedSummary.trim().length > 0);
      findings.push({
        reason: "missing-description",
        severity: derived ? "medium" : "high",
        message: derived
          ? "Frontmatter has no `description`; a summary was derived from the opening text. Adding one improves how reliably the skill triggers."
          : "Frontmatter has no `description`, and no opening text to derive one from. Nothing decides when this skill triggers.",
        file: markerPath,
      });
    } else if (description.length > 0) {
      if (description.length < MIN_DESCRIPTION) {
        findings.push({
          reason: "description-too-short",
          severity: "medium",
          message: `Description is ${description.length} characters; under ${MIN_DESCRIPTION} rarely carries enough signal to trigger reliably.`,
          file: markerPath,
        });
      }
      if (description.length > MAX_DESCRIPTION) {
        findings.push({
          reason: "description-too-long",
          severity: "low",
          message: `Description is ${description.length} characters, over the ${MAX_DESCRIPTION} budget.`,
          file: markerPath,
        });
      }
      const vague = [...description.matchAll(VAGUE_TERMS)].map((m) => m[0].toLowerCase());
      if (vague.length >= 2) {
        findings.push({
          reason: "vague-description",
          severity: "low",
          message: `Description leans on vague words (${[...new Set(vague)].join(", ")}) rather than concrete triggers.`,
          file: markerPath,
        });
      }
    }

    // Size and progressive disclosure.
    if (bodyBytes > MAX_BODY_BYTES) {
      findings.push({
        reason: "oversized-marker",
        severity: "medium",
        message: `${markerPath} is ${Math.round(bodyBytes / 1024)} KB. Move detail into references/ so the agent loads it only when needed.`,
        file: markerPath,
      });
    } else if (bodyBytes > DISCLOSURE_HINT_BYTES && !hasDir(files, "references")) {
      findings.push({
        reason: "no-progressive-disclosure",
        severity: "low",
        message: `${markerPath} is ${Math.round(bodyBytes / 1024)} KB with no references/ directory.`,
        file: markerPath,
      });
    }

    // Broken internal links and orphaned resources.
    const present = new Set(files.map((file) => file.path));
    const linked = new Set<string>();

    for (const link of internalLinks(body)) {
      const target = normalizeLink(link, markerPath);
      if (!target) continue;
      linked.add(target);
      const hit = present.has(target) || [...present].some((p) => p.startsWith(`${target}/`));
      if (!hit) {
        findings.push({
          reason: "broken-internal-link",
          severity: "low",
          message: `Links to \`${link}\`, which is not in the bundle.`,
          file: markerPath,
        });
      }
    }

    const orphans = files
      .map((file) => file.path)
      .filter(
        (path) =>
          path !== markerPath &&
          !linked.has(path) &&
          ![...linked].some((target) => path.startsWith(`${target}/`)),
      );
    if (orphans.length > 0 && files.length > 1) {
      findings.push({
        reason: "orphaned-resources",
        severity: "info",
        message: `${orphans.length} file(s) ship with the skill but are never referenced: ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? " …" : ""}`,
      });
    }

    const blocking = findings.some((f) => f.severity === "high" || f.severity === "critical");
    return {
      result: blocking ? "fail" : findings.length > 0 ? "warn" : "pass",
      findings,
      data: {
        bodyBytes,
        fileCount: files.length,
        descriptionLength: description.length,
        hasReferences: hasDir(files, "references"),
        hasScripts: hasDir(files, "scripts"),
        hasAssets: hasDir(files, "assets"),
      },
    };
  },
};

function hasDir(files: { path: string }[], dir: string): boolean {
  return files.some((file) => file.path.startsWith(`${dir}/`));
}

/** Markdown links that point inside the bundle rather than at the web. */
function* internalLinks(body: string): Generator<string> {
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const match of body.matchAll(pattern)) {
    const href = match[1];
    if (/^(https?:|mailto:|#|<)/i.test(href)) continue;
    yield href;
  }
}

function normalizeLink(href: string, markerPath: string): string | null {
  const clean = href.split("#")[0].split("?")[0].replace(/^\.\//, "");
  if (clean.length === 0 || clean.startsWith("/") || clean.startsWith("..")) return null;
  const dir = markerPath.includes("/")
    ? markerPath.slice(0, markerPath.lastIndexOf("/") + 1)
    : "";
  return `${dir}${clean}`.replace(/\/{2,}/g, "/");
}
