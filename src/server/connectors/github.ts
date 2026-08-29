import "server-only";

import { detectSkills } from "@/server/skills/detect";

import type {
  Connector,
  EnumerateResult,
  FetchedSkill,
  SkillRef,
  SourceConfig,
} from "./types";

/**
 * GitHub repository connector.
 *
 * Two API calls per repo, whatever its size: repo metadata, then the recursive git tree.
 * File contents come from raw.githubusercontent.com, which does **not** consume the
 * 5,000/hour API budget — that is what makes syncing a repo with fifty skills cheap.
 *
 * Every raw fetch is pinned to a commit SHA rather than a branch, so a fetch is
 * reproducible and a force-push cannot silently change what we validated.
 */

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

type RepoMeta = {
  full_name: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  open_issues_count: number;
  fork: boolean;
  license: { spdx_id: string | null } | null;
};

type TreeEntry = { path: string; type: "blob" | "tree"; size?: number };

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url
    .trim()
    .replace(/\.git$/, "")
    .match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error(`Not a GitHub repository URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function apiHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    // 60 requests/hour unauthenticated is not enough to sync anything.
    throw new Error("GITHUB_TOKEN is not set");
  }
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "skill-foundry",
  };
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: apiHeaders() });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new Error(
      `GitHub ${path} failed: ${response.status}` +
        (remaining === "0" ? " (rate limit exhausted)" : ""),
    );
  }
  return (await response.json()) as T;
}

/** Raw content, pinned to a commit. Cheap: it is not part of the API rate limit. */
async function rawFile(
  owner: string,
  repo: string,
  commitSha: string,
  path: string,
): Promise<Buffer | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${RAW}/${owner}/${repo}/${commitSha}/${encoded}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`raw fetch ${path} failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export const githubConnector: Connector = {
  kind: "github_repo",

  async enumerate(config: SourceConfig): Promise<EnumerateResult> {
    const { owner, repo } = parseRepoUrl(config.url);

    const meta = await api<RepoMeta>(`/repos/${owner}/${repo}`);
    const ref = config.ref ?? meta.default_branch;

    // Resolve the ref to an immutable commit, then read the tree at that commit. Pinning
    // here is what makes a later re-fetch reproducible and a force-push detectable.
    const head = await api<{ sha: string }>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    const commitSha = head.sha;
    if (!commitSha) {
      throw new Error(`Could not resolve ${owner}/${repo}@${ref} to a commit`);
    }

    const tree = await api<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    );
    if (tree.truncated) {
      // Silence here would mean a partial corpus that looks complete.
      throw new Error(
        `Tree for ${owner}/${repo} is truncated — too large for one call. ` +
          `Narrow it with includePaths, or use the tarball path (Phase 2).`,
      );
    }

    const paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    const detected = detectSkills(paths, { includePaths: config.includePaths });

    return {
      refs: detected.map((skill) => ({
        path: skill.dir,
        dialect: skill.dialect,
        commitSha,
        files: skill.files,
        licenseCandidates: skill.licenseCandidates,
      })),
      signals: {
        stars: meta.stargazers_count,
        forks: meta.forks_count,
        watchers: meta.subscribers_count,
        openIssues: meta.open_issues_count,
      },
      repoLicenseSpdx: normalizeSpdx(meta.license?.spdx_id ?? null),
      cursor: null,
    };
  },

  async fetch(config: SourceConfig, ref: SkillRef): Promise<FetchedSkill> {
    const { owner, repo } = parseRepoUrl(config.url);
    const prefix = ref.path === "" ? "" : `${ref.path}/`;

    const files = [];
    for (const relative of ref.files) {
      const content = await rawFile(owner, repo, ref.commitSha, `${prefix}${relative}`);
      // A file in the tree that 404s on raw is a genuine anomaly, not a skip.
      if (content === null) {
        throw new Error(`${prefix}${relative} is in the tree but missing at raw`);
      }
      files.push({ path: relative, content });
    }

    const licenseFiles = [];
    for (const path of ref.licenseCandidates) {
      const content = await rawFile(owner, repo, ref.commitSha, path);
      if (content) licenseFiles.push({ path, content });
    }

    return { ref, files, licenseFiles };
  },
};

/** GitHub reports "NOASSERTION" and "other" for things it cannot identify. */
function normalizeSpdx(spdx: string | null): string | null {
  if (!spdx) return null;
  const upper = spdx.toUpperCase();
  return upper === "NOASSERTION" || upper === "OTHER" ? null : spdx;
}
