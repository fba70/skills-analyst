import "server-only";

import { ingestPolicy } from "@/server/crawl/policy";
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
 * File contents come from raw.githubusercontent.com, which does not consume the
 * 5,000/hour *API* budget — but it is not free either. It has its own undocumented
 * limiting, and a run fetching thousands of files across many repositories earns a 429.
 * So raw fetches retry with backoff and run at modest concurrency.
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

type TreeEntry = {
  path: string;
  type: "blob" | "tree";
  size?: number;
  /** Git file mode. `120000` is a symlink — see `isSymlink`. */
  mode?: string;
};

/**
 * Git stores a symlink as a blob whose *content is the target path*.
 *
 * Fetched over raw.githubusercontent.com that is exactly what comes back: the string
 * `../../../.config/agents/rules/panda-css.md`, not the file it points at. Treated as a
 * regular blob it becomes a 40-byte "skill" whose entire body is a path.
 *
 * That is not hypothetical — 217 of the 245 skills quarantined for "no frontmatter block"
 * were symlinks. They landed in quarantine, which was the right outcome for the wrong
 * reason: the verdict said `missing-name` when the truth was that we had ingested a
 * pointer instead of a document, hashed it, and stored it.
 *
 * Skipped rather than resolved. Nearly all of them point *outside* the skill directory
 * (`../../../…`) at files the crawl reaches on their own terms anyway, and following
 * arbitrary relative paths out of a bundle is a directory-traversal problem we would be
 * choosing to have.
 */
function isSymlink(entry: TreeEntry): boolean {
  return entry.mode === "120000";
}

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
    "user-agent": "skills-foundry",
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

/**
 * Raw content, pinned to a commit.
 *
 * Outside the API rate limit, but not unlimited: sustained fetching returns 429, which
 * ended four of ten repositories in one run before this retry existed. Backoff is
 * exponential with jitter — a fixed delay just re-synchronises every worker into the next
 * wall together.
 */
async function rawFile(
  owner: string,
  repo: string,
  commitSha: string,
  path: string,
): Promise<Buffer | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `${RAW}/${owner}/${repo}/${commitSha}/${encoded}`;

  for (let attempt = 0; attempt <= ingestPolicy.rawMaxRetries; attempt += 1) {
    const response = await fetch(url);

    if (response.status === 404) return null;
    if (response.ok) return Buffer.from(await response.arrayBuffer());

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === ingestPolicy.rawMaxRetries) {
      throw new Error(`raw fetch ${path} failed: ${response.status}`);
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : ingestPolicy.rawBackoffBaseMs * 2 ** attempt + Math.random() * 500;
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  throw new Error(`raw fetch ${path} failed after retries`);
}

/**
 * Every blob path at a commit, optionally scoped to a set of prefixes.
 *
 * The scoped path exists because the unscoped one has a hard ceiling: `?recursive=1`
 * truncates above ~100k entries, and a truncated tree is refused rather than used — a
 * partial corpus that looks complete is worse than an error. That ceiling is what stops
 * `liferay/liferay-portal` from syncing even though it holds real skills.
 *
 * `includePaths` is the way out, and it only works if it is applied *before* the call
 * rather than as a filter afterwards. GitHub's tree endpoint accepts a path-scoped SHA in
 * `{commit}:{path}` form, so each prefix is read as its own subtree and the repository
 * root is never listed at all. Costs one API call per prefix instead of one per repo,
 * which is the trade a curator is making when they name the prefixes.
 *
 * A subtree that truncates on its own still throws: the same reasoning applies one level
 * down, and the answer is a narrower prefix.
 */
async function listBlobPaths(
  owner: string,
  repo: string,
  commitSha: string,
  includePaths: string[] | undefined,
): Promise<string[]> {
  const prefixes = (includePaths ?? [])
    .map((prefix) => prefix.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);

  if (prefixes.length === 0) {
    const tree = await api<{ tree: TreeEntry[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    );
    if (tree.truncated) {
      throw new Error(
        `Tree for ${owner}/${repo} is truncated — too large for one call. ` +
          `Narrow it with includePaths, or use the tarball path (Phase 2).`,
      );
    }
    return tree.tree
      .filter((entry) => entry.type === "blob" && !isSymlink(entry))
      .map((entry) => entry.path);
  }

  const paths: string[] = [];
  for (const prefix of prefixes) {
    let subtree: { tree: TreeEntry[]; truncated: boolean };
    try {
      subtree = await api<{ tree: TreeEntry[]; truncated: boolean }>(
        `/repos/${owner}/${repo}/git/trees/${commitSha}:${encodeURIComponent(prefix)}?recursive=1`,
      );
    } catch (error) {
      // A prefix that does not exist is a curator typo, and naming it is more useful
      // than failing the whole repository with a generic 404.
      throw new Error(
        `Include path "${prefix}" could not be read in ${owner}/${repo}: ${(error as Error).message}`,
      );
    }

    if (subtree.truncated) {
      throw new Error(
        `Subtree "${prefix}" in ${owner}/${repo} is itself truncated — narrow it further.`,
      );
    }

    // Subtree paths are relative to the prefix; re-qualify so detection and every later
    // raw fetch see repository-relative paths, as they would from an unscoped tree.
    for (const entry of subtree.tree) {
      if (entry.type === "blob" && !isSymlink(entry)) paths.push(`${prefix}/${entry.path}`);
    }
  }

  return paths;
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

    const paths = await listBlobPaths(owner, repo, commitSha, config.includePaths);
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

    if (ref.files.length > ingestPolicy.maxBundleFiles) {
      throw new Error(
        `${ref.path || "<root>"} claims ${ref.files.length} files, over the ` +
          `${ingestPolicy.maxBundleFiles} cap — detection is treating a project as a skill`,
      );
    }

    // Bounded parallelism: sequential fetching made a 12-file skill take a dozen
    // round-trips end to end, and a large one minutes.
    const files = await mapWithConcurrency(
      ref.files,
      ingestPolicy.fetchConcurrency,
      async (relative) => {
        const content = await rawFile(owner, repo, ref.commitSha, `${prefix}${relative}`);
        // A file in the tree that 404s on raw is a genuine anomaly, not a skip.
        if (content === null) {
          throw new Error(`${prefix}${relative} is in the tree but missing at raw`);
        }
        return { path: relative, content };
      },
    );

    const fetchedLicenses = await mapWithConcurrency(
      ref.licenseCandidates,
      ingestPolicy.fetchConcurrency,
      async (path) => ({ path, content: await rawFile(owner, repo, ref.commitSha, path) }),
    );
    const licenseFiles = fetchedLicenses
      .filter((entry): entry is { path: string; content: Buffer } => entry.content !== null);

    return { ref, files, licenseFiles };
  },
};

/** Runs `worker` over `items`, at most `limit` at a time, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** GitHub reports "NOASSERTION" and "other" for things it cannot identify. */
function normalizeSpdx(spdx: string | null): string | null {
  if (!spdx) return null;
  const upper = spdx.toUpperCase();
  return upper === "NOASSERTION" || upper === "OTHER" ? null : spdx;
}
