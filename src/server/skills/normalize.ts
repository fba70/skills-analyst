import "server-only";

import { parse as parseYaml } from "yaml";

import type { SkillDialect } from "./detect";

/**
 * Heterogeneous dialects into one canonical shape (Doc 2 R1.2).
 *
 * Superset, not lowest common denominator: `dialect` records where a skill came from and
 * `extra` keeps every frontmatter key we do not model, so adopting a new dialect never
 * loses information and never needs a migration to add a field back.
 *
 * Nothing here throws on bad input. An unparseable skill is not dropped — it comes back
 * with `parseError` set and lands in the triage queue, which is what R1.2 requires.
 */

export type NormalizedSkill = {
  name: string;
  slug: string;
  summary: string | null;
  dialect: SkillDialect;
  /** Raw frontmatter, canonical keys plus everything else under `extra`. */
  frontmatter: Record<string, unknown>;
  /** The `license` field verbatim, for the licence chain. */
  frontmatterLicense: unknown;
  /** Body with frontmatter stripped, for analysis and archetype mining. */
  body: string;
  parseError: string | null;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(markdown: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  error: string | null;
} {
  const match = markdown.match(FRONTMATTER);
  if (!match) {
    return { frontmatter: {}, body: markdown, error: "no frontmatter block" };
  }

  try {
    const parsed = parseYaml(match[1]);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { frontmatter: {}, body: markdown.slice(match[0].length), error: "frontmatter is not a mapping" };
    }
    return {
      frontmatter: parsed as Record<string, unknown>,
      body: markdown.slice(match[0].length),
      error: null,
    };
  } catch (error) {
    return {
      frontmatter: {},
      body: markdown.slice(match[0].length),
      error: `invalid YAML: ${(error as Error).message}`,
    };
  }
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "unnamed-skill";
}

/**
 * `markerContent` is the SKILL.md (or AGENTS.md) body; `dirName` is the fallback name,
 * because a directory name is a better identifier than "unnamed" when frontmatter is
 * missing.
 */
export function normalizeSkill(input: {
  dialect: SkillDialect;
  dirName: string;
  markerContent: Buffer;
}): NormalizedSkill {
  const text = input.markerContent.toString("utf8");
  const { frontmatter, body, error } = splitFrontmatter(text);

  const name =
    firstString(frontmatter.name) ??
    firstString(frontmatter.title) ??
    headingOf(body) ??
    input.dirName;

  const summary =
    firstString(frontmatter.description) ??
    firstString(frontmatter.summary) ??
    firstParagraph(body);

  return {
    name,
    slug: slugify(firstString(frontmatter.name) ?? input.dirName),
    summary,
    dialect: input.dialect,
    frontmatter,
    frontmatterLicense: frontmatter.license ?? frontmatter.licence ?? null,
    body,
    parseError: error,
  };
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headingOf(body: string): string | null {
  const match = body.match(/^\s*#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function firstParagraph(body: string): string | null {
  const paragraph = body
    .replace(/^\s*#.*$/gm, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0);
  if (!paragraph) return null;
  const flattened = paragraph.replace(/\s+/g, " ");
  return flattened.length > 400 ? `${flattened.slice(0, 397)}...` : flattened;
}
