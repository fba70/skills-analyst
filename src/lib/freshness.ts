/**
 * Freshness (Doc 6 RK.2, plan step E1).
 *
 * ## The mechanism existed and had no way in
 *
 * A4 shipped `review_by` and a derived `stale` state, and the only way to set a date was
 * `pnpm lifecycle --review-by`. CLAUDE.md said so at the time and named the reason it was
 * deferred: *a panel that can set a review date but cannot yet tell anyone it has passed is
 * furniture.* E1 is the telling-anyone half — the overdue list, the nudge, and the one kind of
 * decay a skill suffers that nobody has to declare.
 *
 * ## Link rot is the only automatic freshness signal there is
 *
 * Everything else about staleness is somebody's judgement expressed as a date. A dead link is a
 * fact: the skill points at documentation that has gone, and no human said so. It is also the
 * commonest way a skill quietly stops working — a `reference-pointer` block to a vendor page
 * that moved is a skill that now sends an agent nowhere.
 */

/**
 * What a fetch told us, and what it is safe to conclude.
 *
 * Four states rather than ok/broken, because **most non-200 responses are not rot** and treating
 * them as such would fill the panel with sites that dislike robots. Only `broken` is a confident
 * claim about the link.
 */
export const LINK_STATUSES = ["ok", "broken", "unreachable", "blocked"] as const;

export type LinkStatus = (typeof LINK_STATUSES)[number];

export const LINK_STATUS_META: Record<LinkStatus, { label: string; blurb: string }> = {
  ok: { label: "OK", blurb: "The server answered." },
  broken: {
    label: "Gone",
    blurb: "404 or 410 — the page the skill points at does not exist.",
  },
  unreachable: {
    label: "Unreachable",
    blurb: "DNS failure, timeout, or a connection that never completed. Often temporary.",
  },
  blocked: {
    label: "Blocked",
    blurb:
      "401, 403 or 429 — the server refused us specifically. Says nothing about whether the page is there.",
  },
};

/**
 * Classify one HTTP outcome.
 *
 * `null` status means the request never completed at all. The 4xx split is the important part:
 * a 404 is the page saying it is gone, and a 403 is the site saying *you* may not have it — which
 * is a fact about our user agent, not about the link. Reporting the second as rot would send an
 * author to fix a document that is fine.
 */
export function classifyLink(status: number | null): LinkStatus {
  if (status === null) return "unreachable";
  if (status === 404 || status === 410) return "broken";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status >= 500) return "unreachable";
  return "ok";
}

/**
 * Consecutive failures before a link is reported as rotten.
 *
 * One failed fetch is not rot. A deploy, a rate limit, a flaky CDN edge and a network blip all
 * look identical to a single request, and a panel that cried wolf on any of them would be
 * ignored within a week — the alarm-nobody-can-silence problem, arriving from the other
 * direction.
 *
 * Two, not five: a link checked daily and dead for two days is dead, and waiting a working week
 * to say so makes the signal useless for the case it exists for.
 */
export const ROT_THRESHOLD = 2;

/** Only a `broken` link ever rots. See `classifyLink` — the others are facts about us. */
export function isRotten(status: LinkStatus, consecutiveFailures: number): boolean {
  return status === "broken" && consecutiveFailures >= ROT_THRESHOLD;
}

/**
 * How stale a review date is, in the words a panel uses.
 *
 * `null` for a skill with no date at all, which is most of them and is **not** a problem —
 * a review date is a governance decision somebody made, and its absence means nobody has made
 * one rather than that the skill is neglected. A panel that listed every undated skill as
 * outstanding would be listing the whole corpus.
 */
export type ReviewUrgency = "overdue" | "due-soon" | "scheduled" | null;

/** Days before a review date at which it is worth mentioning. */
export const DUE_SOON_DAYS = 14;

export function reviewUrgency(reviewBy: Date | null, now = new Date()): ReviewUrgency {
  if (!reviewBy) return null;
  const days = (reviewBy.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return "overdue";
  if (days <= DUE_SOON_DAYS) return "due-soon";
  return "scheduled";
}

/**
 * Links this checker will not follow.
 *
 * Not a security boundary — the fetch has a deadline and reads nothing — but a politeness and
 * noise one. `localhost` and private ranges are somebody's development notes; `example.com` is a
 * placeholder by RFC; a mailto or a template variable is not a URL to check.
 */
export function isCheckableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();

  /* A placeholder somebody left in: `https://<your-host>/api`, `${BASE_URL}/x`. */
  if (/[<>{}$]/.test(url)) return false;

  /*
   * No dot in the hostname means it is not a public name at all.
   *
   * The first pass through the real corpus turned up `http://burpsuite`, `http://internal-api/process`
   * and `http://model_a` — somebody's internal host, or a word in a sentence that happened to
   * follow `http://`. Each cost a real DNS lookup and landed in the panel as `unreachable`, which
   * is true and useless.
   */
  if (!host.includes(".")) return false;

  if (host.endsWith(".local")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;

  /*
   * RFC 2606 and RFC 6761 reserved names, **including subdomains**.
   *
   * The first version matched `example.com` exactly and missed `api.example.com`,
   * `staging.example.com` and `attacker-server.example.com` — which between them were most of
   * what the first real pass reported as unreachable. A documentation corpus is full of
   * illustrative hostnames by construction, so this is the single highest-value filter here.
   */
  if (RESERVED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return false;
  }
  if (/\.(test|invalid|localhost|example)$/.test(host)) return false;

  return true;
}

/** Reserved for documentation by RFC 2606, plus the `.example` TLD's second-level cousins. */
const RESERVED_HOSTS = ["example.com", "example.org", "example.net", "localhost"] as const;

/**
 * How long to wait before re-checking a document that has an outstanding failure.
 *
 * **Without this, `ROT_THRESHOLD` is unreachable.** A selector that only walks oldest-first gets
 * back to a given document once per full sweep of the corpus, which at a couple of hundred a pass
 * over 49,000 is months — so a link that 404s twice never gets asked twice, and nothing is ever
 * reported. The first real pass found 50 links returning 404 and reported none of them, which is
 * how this was discovered.
 *
 * Six hours: long enough that a deploy or a rate-limit window has passed, short enough that a
 * genuinely dead link is confirmed the same day.
 */
export const RECHECK_AFTER_HOURS = 6;

/** How many links one skill contributes to a check pass. A fuse, not a setting. */
export const MAX_LINKS_PER_SKILL = 20;
