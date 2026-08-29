import "server-only";

/**
 * Which directories in a file tree hold a skill, and in which dialect.
 *
 * Detection is deliberately shallow: a skill is a *directory* whose marker file is
 * present. Everything beside the marker travels with it as the bundle. That is what
 * makes a skill an atomic artifact (Doc 2 R1.1) rather than a loose file.
 */

export type SkillDialect =
  | "anthropic_skill"
  | "claude_plugin"
  | "openclaw_skill"
  | "cursor_rule"
  | "agents_md"
  | "unknown";

/** Marker file → dialect, in priority order: the first match wins for a directory. */
const MARKERS: Array<{ file: string; dialect: SkillDialect }> = [
  { file: "SKILL.md", dialect: "anthropic_skill" },
  { file: "skill.md", dialect: "anthropic_skill" },
  { file: "AGENTS.md", dialect: "agents_md" },
];

/** Never travel with a skill: noise, or things we must not mirror. */
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "__pycache__", ".venv"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);

/** Licence files, matched case-insensitively at any level while walking up. */
const LICENSE_PATTERN = /^(licen[cs]e|copying|notice)(\.[a-z0-9]+)?$/i;

export function isLicenseFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return LICENSE_PATTERN.test(name);
}

function isExcluded(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  return EXCLUDED_FILES.has(segments[segments.length - 1] ?? "");
}

export type DetectedSkill = {
  /** Directory holding the marker. "" means the repo root is itself a skill. */
  dir: string;
  dialect: SkillDialect;
  /** Paths relative to `dir`, marker first. */
  files: string[];
  /** Licence file paths (repo-relative) from nearest to outermost. */
  licenseCandidates: string[];
};

/**
 * Finds skills in a flat list of repo-relative file paths.
 *
 * Nested skills are allowed — a monorepo of skills is the normal shape — but a file is
 * only ever claimed by the *deepest* skill directory above it, so a parent skill does not
 * swallow its children's files.
 */
export function detectSkills(
  allPaths: string[],
  options: { includePaths?: string[] } = {},
): DetectedSkill[] {
  const paths = allPaths.filter((path) => !isExcluded(path));
  const include = (options.includePaths ?? []).filter(Boolean);
  const inScope = (path: string) =>
    include.length === 0 || include.some((prefix) => path.startsWith(prefix));

  // Directory -> dialect, for every directory holding a marker file.
  const skillDirs = new Map<string, SkillDialect>();
  for (const path of paths) {
    if (!inScope(path)) continue;
    const name = path.split("/").pop() ?? "";
    const marker = MARKERS.find((candidate) => candidate.file === name);
    if (!marker) continue;
    const dir = path.slice(0, Math.max(0, path.length - name.length - 1));
    // First marker wins, so SKILL.md beats a sibling AGENTS.md.
    if (!skillDirs.has(dir)) skillDirs.set(dir, marker.dialect);
  }

  const licensePaths = paths.filter(isLicenseFile);
  // Deepest first, so each file is claimed by the nearest enclosing skill.
  const dirsByDepth = [...skillDirs.keys()].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );

  const claimed = new Set<string>();
  const detected: DetectedSkill[] = [];

  for (const dir of dirsByDepth) {
    const prefix = dir === "" ? "" : `${dir}/`;
    const files: string[] = [];

    for (const path of paths) {
      if (!path.startsWith(prefix) || claimed.has(path)) continue;
      if (isLicenseFile(path)) continue; // travels separately, not part of the bundle
      files.push(path.slice(prefix.length));
      claimed.add(path);
    }

    if (files.length === 0) continue;

    const dialect = skillDirs.get(dir)!;
    const markerFile = MARKERS.find((m) => m.dialect === dialect)?.file;
    files.sort((a, b) => (a === markerFile ? -1 : b === markerFile ? 1 : a.localeCompare(b)));

    detected.push({
      dir,
      dialect,
      files,
      licenseCandidates: nearestLicenses(dir, licensePaths),
    });
  }

  return detected.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Licence files visible from a skill directory, nearest first.
 *
 * The order is the whole point: `anthropics/skills` licenses each skill directory
 * separately, and the repo root has no LICENSE at all. A repo-level answer would be wrong
 * in the dangerous direction — it would mirror proprietary content.
 */
export function nearestLicenses(dir: string, licensePaths: string[]): string[] {
  const segments = dir === "" ? [] : dir.split("/");
  const found: string[] = [];

  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join("/");
    const matches = licensePaths.filter((path) => {
      const parent = path.split("/").slice(0, -1).join("/");
      return parent === prefix;
    });
    found.push(...matches.sort());
  }

  return found;
}
