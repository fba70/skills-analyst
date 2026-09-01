import "server-only";
import { fetchWithDeadline } from "@/server/http/deadline";

import { MAX_PAGES, PAGE_SIZE } from "./shards";

/**
 * GitHub code search, with its two hard limits handled explicitly.
 *
 *   - ~10 requests per minute. Not a suggestion: exceeding it returns 403s that look like
 *     auth failures. We pace ourselves rather than retrying into the wall.
 *   - 1,000 results per query, whatever `total_count` says.
 *
 * Code search also needs the `text-match`-era Accept header on some endpoints and returns
 * `incomplete_results` when it gave up early — that flag is surfaced rather than ignored,
 * because silently treating a partial page as complete is how coverage claims become
 * false.
 */

const API = "https://api.github.com";

/** Slightly under the documented 10/min, since the window is not exactly aligned. */
const MIN_REQUEST_INTERVAL_MS = 6_500;

export type CodeSearchItem = {
  path: string;
  repository: {
    fullName: string;
    owner: string;
    name: string;
    htmlUrl: string;
    fork: boolean;
  };
};

export type CodeSearchPage = {
  totalCount: number;
  incompleteResults: boolean;
  items: CodeSearchItem[];
};

type RawItem = {
  path: string;
  repository: {
    full_name: string;
    name: string;
    html_url: string;
    fork: boolean;
    owner: { login: string };
  };
};

let lastRequestAt = 0;

/** Serialises requests to stay under the per-minute ceiling. */
async function pace(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

function headers(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "skills-foundry",
  };
}

export class RateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`GitHub rate limit hit; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimited";
  }
}

export async function searchCode(
  query: string,
  page: number,
): Promise<CodeSearchPage> {
  if (page > MAX_PAGES) {
    throw new Error(`Page ${page} is past the ${MAX_PAGES}-page result cap`);
  }

  await pace();

  const url =
    `${API}/search/code?q=${encodeURIComponent(query)}` +
    `&per_page=${PAGE_SIZE}&page=${page}`;
  const response = await fetchWithDeadline(url, { headers: headers() });

  if (response.status === 403 || response.status === 429) {
    // Secondary rate limits answer with Retry-After; primary ones with a reset epoch.
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Number.isFinite(reset) && reset > 0
        ? Math.max(0, reset * 1000 - Date.now())
        : 60_000;
    throw new RateLimited(waitMs);
  }

  if (!response.ok) {
    throw new Error(`code search failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    total_count: number;
    incomplete_results: boolean;
    items: RawItem[];
  };

  return {
    totalCount: body.total_count,
    incompleteResults: body.incomplete_results,
    items: (body.items ?? []).map((item) => ({
      path: item.path,
      repository: {
        fullName: item.repository.full_name,
        owner: item.repository.owner.login,
        name: item.repository.name,
        htmlUrl: item.repository.html_url,
        fork: item.repository.fork,
      },
    })),
  };
}
