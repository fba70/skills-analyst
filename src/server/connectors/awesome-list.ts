import "server-only";

/**
 * Awesome-list expansion (Doc 2 R1.1b, Doc 4 §4 step 2).
 *
 * A curated list is not a source of *content* — it is a source of *candidates*, and of the
 * one signal the open crawl cannot manufacture: a human decided this repository was worth
 * listing. So this connector never fetches a skill. It reads markdown, extracts GitHub
 * repository URLs, and hands them to the same enrich → decide → sync → validate path that
 * the code-search crawl feeds. Content is always fetched from origin under the origin's
 * licence, which is the ToS rule in Doc 4 §3 and the reason we stay an aggregator other
 * registries can partner with.
 *
 * ## What counts as a candidate
 *
 * Only `github.com/owner/repo` links. Deliberately narrow:
 *
 *   - **Deeper paths collapse to their repo.** A link to `/owner/repo/tree/main/skills/foo`
 *     is a pointer at one skill inside a repo we want whole — detection finds the rest.
 *   - **Non-repo GitHub URLs are dropped.** `/sponsors/x`, `/orgs/y`, `/topics/z`,
 *     `/apps/…` and bare user profiles are not repositories, and a reserved-word list is
 *     what stops `github.com/sponsors/someone` becoming the repo `sponsors/someone`.
 *   - **Badge and image URLs are dropped.** An awesome list is mostly shields.io badges
 *     pointing at the list's own repo; counting those would rank the list above everything
 *     it lists.
 *   - **The list's own repository is dropped.** Self-reference, every time, at the top.
 *
 * ## Ordering is the point
 *
 * Candidates come back in document order, and position in a curated list is real signal —
 * the top of a section is where the maintainer put the thing they actually recommend. The
 * caller keeps that as `listRank` so promotion can prefer it over an arbitrary crawl hit.
 */

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** GitHub paths that are never a repository. */
const RESERVED_OWNERS = new Set([
  "sponsors",
  "orgs",
  "topics",
  "collections",
  "events",
  "apps",
  "marketplace",
  "features",
  "pricing",
  "about",
  "explore",
  "trending",
  "settings",
  "notifications",
  "search",
  "login",
  "join",
  "site",
  "readme",
  "security",
  "enterprise",
  "customer-stories",
  "users",
]);

/** Repo names that are really a path segment of something else. */
const RESERVED_REPOS = new Set(["blob", "tree", "raw", "releases", "issues", "pulls", "wiki"]);

export type ListCandidate = {
  owner: string;
  repo: string;
  url: string;
  /** 1-based position in the list. Lower means the curator surfaced it earlier. */
  listRank: number;
  /** Nearest preceding heading — the list's own category for this entry. */
  section: string | null;
  /** The link text, which is usually the entry's name. */
  label: string | null;
};

export type ParsedList = {
  candidates: ListCandidate[];
  /** Every distinct GitHub link seen, before filtering. For reporting coverage. */
  linksSeen: number;
  /** Markdown files actually read. */
  filesRead: string[];
};

function headers(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "skill-foundry",
  };
}

/**
 * Pulls owner/repo out of any github.com URL, or null when it is not a repository.
 *
 * Exported because the submission path needs the same judgement, and two copies of a rule
 * this fiddly would drift.
 */
export function repoFromUrl(raw: string): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");

  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (RESERVED_REPOS.has(repo.toLowerCase())) return null;
  // A repo name is bounded and cannot contain these; anything else is a malformed link.
  if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) return null;

  return { owner, repo };
}

/** Markdown inline links and bare autolinks, in document order. */
function* linksIn(markdown: string): Generator<{ url: string; label: string | null }> {
  // Strip fenced code first: a README's install snippet is not a recommendation.
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

  const inline = /(!)?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  for (const match of withoutCode.matchAll(inline)) {
    // A leading `!` makes it an image — badges, not entries.
    if (match[1]) continue;
    yield { url: match[3], label: match[2].trim() || null };
  }

  const autolink = /<(https?:\/\/[^>\s]+)>/g;
  for (const match of withoutCode.matchAll(autolink)) {
    yield { url: match[1], label: null };
  }
}

/** Heading immediately above a given offset, as the entry's section. */
function sectionAt(markdown: string, offset: number): string | null {
  const before = markdown.slice(0, offset);
  const headings = [...before.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const last = headings[headings.length - 1];
  return last ? last[1].replace(/[`*_]/g, "").trim().slice(0, 120) : null;
}

export type ParseOptions = {
  /** Do not return this repository as a candidate — it is the list itself. */
  selfRepo?: { owner: string; repo: string };
};

export function parseListMarkdown(
  markdown: string,
  options: ParseOptions = {},
): Omit<ParsedList, "filesRead"> {
  const seen = new Set<string>();
  const candidates: ListCandidate[] = [];
  let linksSeen = 0;

  // Re-scan for offsets so each link can be tied to the heading above it.
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const offsets = new Map<string, number>();
  for (const match of withoutCode.matchAll(/(!)?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) {
    if (!match[1] && match.index !== undefined && !offsets.has(match[3])) {
      offsets.set(match[3], match.index);
    }
  }

  for (const { url, label } of linksIn(markdown)) {
    if (!/github\.com/i.test(url)) continue;
    linksSeen += 1;

    const parsed = repoFromUrl(url);
    if (!parsed) continue;

    if (
      options.selfRepo &&
      parsed.owner.toLowerCase() === options.selfRepo.owner.toLowerCase() &&
      parsed.repo.toLowerCase() === options.selfRepo.repo.toLowerCase()
    ) {
      continue;
    }

    const key = `${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      owner: parsed.owner,
      repo: parsed.repo,
      url: `https://github.com/${parsed.owner}/${parsed.repo}`,
      listRank: candidates.length + 1,
      section: sectionAt(withoutCode, offsets.get(url) ?? 0),
      label,
    });
  }

  return { candidates, linksSeen };
}

/**
 * Reads a list repository and returns its candidates.
 *
 * Reads the markdown files at the repository root by default. Most awesome lists are one
 * README; a few split by category, and reading every root-level `.md` covers both without
 * needing per-list configuration.
 */
export async function fetchList(input: {
  owner: string;
  repo: string;
  files?: readonly string[];
}): Promise<ParsedList> {
  const { owner, repo } = input;

  const meta = await fetch(`${API}/repos/${owner}/${repo}`, { headers: headers() });
  if (!meta.ok) {
    throw new Error(`Could not read ${owner}/${repo}: GitHub returned ${meta.status}`);
  }
  const { default_branch: branch } = (await meta.json()) as { default_branch: string };

  const head = await fetch(`${API}/repos/${owner}/${repo}/commits/${branch}`, {
    headers: headers(),
  });
  if (!head.ok) throw new Error(`Could not resolve ${owner}/${repo}@${branch}`);
  const commitSha = ((await head.json()) as { sha: string }).sha;

  let targets: string[];
  if (input.files?.length) {
    targets = [...input.files];
  } else {
    const tree = await fetch(
      `${API}/repos/${owner}/${repo}/git/trees/${commitSha}`,
      { headers: headers() },
    );
    if (!tree.ok) throw new Error(`Could not list ${owner}/${repo}`);
    const entries = (await tree.json()) as { tree: Array<{ path: string; type: string }> };
    targets = entries.tree
      .filter((e) => e.type === "blob" && /\.md$/i.test(e.path))
      .map((e) => e.path);
  }

  if (targets.length === 0) {
    throw new Error(`${owner}/${repo} has no markdown files at its root to read as a list.`);
  }

  const merged: ListCandidate[] = [];
  const filesRead: string[] = [];
  const seen = new Set<string>();
  let linksSeen = 0;

  for (const path of targets) {
    // Pinned to the commit, like every other fetch, so a list read is reproducible.
    const response = await fetch(`${RAW}/${owner}/${repo}/${commitSha}/${path}`);
    if (!response.ok) continue;
    const markdown = await response.text();

    const parsed = parseListMarkdown(markdown, { selfRepo: { owner, repo } });
    linksSeen += parsed.linksSeen;
    filesRead.push(path);

    for (const candidate of parsed.candidates) {
      const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...candidate, listRank: merged.length + 1 });
    }
  }

  return { candidates: merged, linksSeen, filesRead };
}
