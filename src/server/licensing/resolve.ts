import "server-only";

import {
  matchSpdxId,
  readFrontmatterLicense,
  readLicenseText,
  type RedistributionPosture,
} from "./detect";

/**
 * The licence chain (Doc 4 §5), resolved **per skill** rather than per repo.
 *
 * Order, and why:
 *   1. frontmatter `license:` — the author's own statement, closest to the artifact.
 *      Decisive only when it is a clean SPDX id or an explicit proprietary claim.
 *   2. nearest in-tree LICENSE, walking up from the skill directory. This is the step
 *      that gets `anthropics/skills` right: each skill directory carries its own file,
 *      and the repo root carries none.
 *   3. the host's repo-level licence (GitHub Licenses API) — a weak, repo-wide hint.
 *   4. unresolved.
 *
 * Steps 4 and 5 of Doc 4's chain (ClearlyDefined, ScanCode) are Phase 2; the shape here
 * leaves room for them between 3 and 4.
 *
 * Every step records evidence, so any decision can be explained and re-run later.
 */

export type LicenseSourceStep =
  | "frontmatter"
  | "in_tree_license"
  | "github_api"
  | "clearlydefined"
  | "scancode"
  | "unresolved";

export type LicenseFile = { path: string; text: string };

export type LicenseResolution = {
  spdx: string | null;
  posture: RedistributionPosture;
  source: LicenseSourceStep;
  evidence: {
    matched: string;
    /** Which file or API answered. */
    from: string | null;
    /** Everything we looked at, in order, so a wrong answer is debuggable. */
    considered: Array<{ step: LicenseSourceStep; from: string; result: string }>;
  };
};

export type ResolveInput = {
  /** Value of the `license` key in the skill's frontmatter, if any. */
  frontmatterLicense?: unknown;
  /** Licence files visible from the skill directory, NEAREST FIRST. */
  licenseFiles: LicenseFile[];
  /** SPDX id the host reported for the whole repo, if any. */
  repoLicenseSpdx?: string | null;
};

export function resolveLicense(input: ResolveInput): LicenseResolution {
  const considered: LicenseResolution["evidence"]["considered"] = [];

  // 1. Frontmatter.
  const fromFrontmatter = readFrontmatterLicense(input.frontmatterLicense);
  considered.push({
    step: "frontmatter",
    from: "SKILL.md",
    result: fromFrontmatter
      ? `${fromFrontmatter.posture} (${fromFrontmatter.matched})`
      : typeof input.frontmatterLicense === "string"
        ? "pointer or unparseable — deferring"
        : "absent",
  });
  if (fromFrontmatter) {
    return {
      spdx: fromFrontmatter.spdx,
      posture: fromFrontmatter.posture,
      source: "frontmatter",
      evidence: { matched: fromFrontmatter.matched, from: "SKILL.md", considered },
    };
  }

  // 2. Nearest in-tree licence file. First readable answer wins — nearest beats outermost.
  for (const file of input.licenseFiles) {
    const reading = readLicenseText(file.text);
    considered.push({
      step: "in_tree_license",
      from: file.path,
      result: `${reading.posture}${reading.spdx ? ` (${reading.spdx})` : ""}`,
    });
    if (reading.posture !== "unresolved") {
      return {
        spdx: reading.spdx,
        posture: reading.posture,
        source: "in_tree_license",
        evidence: { matched: reading.matched, from: file.path, considered },
      };
    }
  }

  // 3. Host's repo-level answer. Weakest signal: it describes the repo, not the skill.
  if (input.repoLicenseSpdx) {
    const mapped = matchSpdxId(input.repoLicenseSpdx);
    considered.push({
      step: "github_api",
      from: "repo",
      result: mapped ? `${mapped.posture} (${mapped.spdx})` : `unknown id ${input.repoLicenseSpdx}`,
    });
    if (mapped) {
      return {
        spdx: mapped.spdx,
        posture: mapped.posture,
        source: "github_api",
        evidence: { matched: "github:spdx", from: "repo", considered },
      };
    }
  } else {
    considered.push({ step: "github_api", from: "repo", result: "none reported" });
  }

  // 4. Unresolved — which withholds the bytes. Metadata and verdicts still happen.
  return {
    spdx: null,
    posture: "unresolved",
    source: "unresolved",
    evidence: { matched: "no positive identification", from: null, considered },
  };
}
