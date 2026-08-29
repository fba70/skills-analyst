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

/** Vague words that make a description trigger badly (R2.8). */
const VAGUE_TERMS =
  /\b(various|stuff|things|etc|powerful|amazing|awesome|best|ultimate|simply|easy)\b/gi;

export const structuralLint: Analyzer = {
  name: "structural-lint",
  version: "1.0.0",

  run({ files, body, frontmatter, markerPath }) {
    const findings: Finding[] = [];
    const bodyBytes = Buffer.byteLength(body, "utf8");

    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

    if (name.length === 0) {
      findings.push({
        reason: "missing-name",
        severity: "high",
        message: "Frontmatter has no `name`. The skill has no identity to match on.",
        file: markerPath,
      });
    } else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      findings.push({
        reason: "name-not-kebab-case",
        severity: "low",
        message: `\`name: ${name}\` is not lowercase-kebab-case, which most tooling assumes.`,
        file: markerPath,
      });
    }

    if (description.length === 0) {
      findings.push({
        reason: "missing-description",
        severity: "high",
        message:
          "Frontmatter has no `description`. That field is what decides when the skill triggers.",
        file: markerPath,
      });
    } else {
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
