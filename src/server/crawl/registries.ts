import "server-only";
import { fetchWithDeadline } from "@/server/http/deadline";


import { db } from "@/server/db";
import { discoveredRepos, events } from "@/server/db/schema";

/**
 * Registry reconciliation — Doc 4 §4 channel 4, and R1.1(d).
 *
 * The three built channels all need someone to already know a URL: a hand-picked seed list,
 * an awesome-list someone wrote, or a code-search crawl that is saturated and cannot
 * finish. An index registry has done the discovery work already, in public, and publishes
 * the result.
 *
 * ## A registry is a discovery source, never a content source
 *
 * Doc 4 §2–3 is explicit and this module holds the line: what we take is the *pointer* —
 * `owner/repo` — and nothing else. Every byte is then fetched from origin by the ordinary
 * pipeline, judged by the ordinary analyzers, and licensed by the ordinary chain. We do not
 * mirror the registry's copy, inherit its verdicts, or trust its metadata.
 *
 * ## Sanctioned interfaces only
 *
 * `skills.sh/robots.txt` allows `/`, and **disallows `/api/` and `/search`** while
 * advertising `/sitemap.xml`. So the sitemap is the interface its operators intend
 * automated readers to use, and it is the only one this reads — no API calls, no search,
 * no page scraping. It also happens to be the cheapest: four XML files answer what 20,000
 * page fetches would have, because the URL itself carries the repository.
 *
 * ## Never auto-promoted
 *
 * Everything lands as an ordinary candidate at `status: "new"` for the existing
 * enrich → decide → promote path to judge. A registry listing is a *popularity* signal and
 * popularity is not quality — the same rule the open-web discovery TODO sets out. The
 * provenance is recorded so a curator can see where the tip came from.
 */

export type RegistryReport = {
  registry: string;
  urlsSeen: number;
  reposFound: number;
  inserted: number;
  alreadyKnown: number;
};

const SKILLS_SH = "https://www.skills.sh";

/**
 * Reads a sitemap index and returns every `<loc>` in its children.
 *
 * Deliberately minimal parsing. A sitemap is a flat list of URLs and a regex over `<loc>`
 * is enough; pulling in an XML parser to walk two levels of a schema this stable would be
 * a dependency for its own sake.
 */
async function locs(url: string): Promise<string[]> {
  const res = await fetchWithDeadline(url, {
    headers: {
      // Identify ourselves. An operator reading their logs should be able to tell who this
      // is and why, and a registry that wants us to stop has a name to point at.
      "User-Agent": "skills-foundry (+registry reconciliation; contact via repository)",
      Accept: "application/xml,text/xml",
    },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * Every repository skills.sh lists, with how many of its skills they index.
 *
 * The URL shape is `/{owner}/{repo}/{skill}`. That third segment is what makes this cheap:
 * the repository is in the path, so counting is arithmetic on a list we already hold rather
 * than a fetch per skill.
 *
 * A three-segment path is required. The sitemap also carries owner pages and static routes,
 * and a looser match would invent repositories out of `/about` and `/pricing`.
 */
export async function readSkillsShIndex(): Promise<{
  urlsSeen: number;
  repos: Array<{ owner: string; repo: string; skillCount: number }>;
}> {
  const index = await locs(`${SKILLS_SH}/sitemap.xml`);
  const skillMaps = index.filter((u) => /sitemap-skills/.test(u));

  const counts = new Map<string, number>();
  let urlsSeen = 0;

  for (const map of skillMaps) {
    for (const url of await locs(map)) {
      urlsSeen += 1;
      const segments = url.replace(/^https?:\/\/[^/]+\//, "").split("/").filter(Boolean);
      if (segments.length !== 3) continue;
      const [owner, repo] = segments;
      // Guard the shape rather than trusting it: these become a URL we will fetch.
      if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) continue;
      const key = `${owner}/${repo}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const repos = [...counts]
    .map(([key, skillCount]) => {
      const [owner, repo] = key.split("/");
      return { owner, repo, skillCount };
    })
    .sort((a, b) => b.skillCount - a.skillCount);

  return { urlsSeen, repos };
}

/**
 * Files registry listings as ordinary discovery candidates.
 *
 * `hitCount` is left at 0, matching the seed path: it means "a list named this", which is a
 * different kind of evidence from "the crawl saw N markers in it" and must not be confused
 * with one. The registry's own count goes in `samplePaths`-adjacent provenance instead —
 * recorded on the event, not on a column that policy reads, so a registry cannot influence
 * a promotion decision by claiming a large number.
 */
export async function importSkillsSh(
  options: { minSkills?: number; limit?: number } = {},
): Promise<RegistryReport> {
  const minSkills = options.minSkills ?? 1;
  const { urlsSeen, repos } = await readSkillsShIndex();
  const eligible = repos.filter((r) => r.skillCount >= minSkills).slice(0, options.limit);

  let inserted = 0;
  let alreadyKnown = 0;

  for (const candidate of eligible) {
    const url = `https://github.com/${candidate.owner}/${candidate.repo}`;
    const [row] = await db
      .insert(discoveredRepos)
      .values({
        host: "github.com",
        owner: candidate.owner,
        repo: candidate.repo,
        url,
        hitCount: 0,
        status: "new",
        submittedBy: "registry:skills.sh",
        samplePaths: null,
      })
      .onConflictDoUpdate({
        /**
         * Expression target, matching `discovered_repos_uq` exactly.
         *
         * Migration 0021 folded that index to `(host, lower(owner), lower(repo))`. Postgres
         * infers the arbiter index from the ON CONFLICT target, and a bare column list
         * cannot match an expression index — it raises 42P10 rather than falling back. So
         * every discovery write threw until this matched: `pnpm crawl` on its first
         * repository, `pnpm registry --import` on the first of 2,422 rows, and `submit`
         * inside its transaction, recording neither source nor candidate.
         *
         * `verify:dedup` stayed green throughout, because it probes a raw INSERT — a shape
         * the application never uses. An ON CONFLICT target is a third reference to an
         * index, after the `where` clauses and the definition itself, and it is the one no
         * grep for a comparison operator can find.
         */
        target: [
          discoveredRepos.host,
          discoveredRepos.ownerFolded,
          discoveredRepos.repoFolded,
        ],
        // Only the sighting is refreshed. Status, skipReason and hitCount are left exactly
        // as they are: a repository a curator already rejected must not be resurrected
        // because a registry still lists it.
        set: { lastSeenAt: new Date() },
      })
      .returning({ id: discoveredRepos.id, firstSeen: discoveredRepos.firstSeenAt });

    // `firstSeenAt` defaults to now on insert, so a row whose first sighting is this run is
    // one we had never seen. Cheaper and more honest than a second query per candidate.
    if (row && Date.now() - row.firstSeen.getTime() < 5_000) inserted += 1;
    else alreadyKnown += 1;
  }

  await db.insert(events).values({
    actorType: "system",
    actorId: "crawl.registry",
    kind: "registry.reconciled",
    subjectType: "discovered_repos",
    subjectId: null,
    reason: `skills.sh: ${eligible.length} repo(s) listed, ${inserted} new`,
    payload: {
      registry: "skills.sh",
      via: "sitemap",
      urlsSeen,
      reposFound: repos.length,
      considered: eligible.length,
      inserted,
      minSkills,
    },
  });

  return {
    registry: "skills.sh",
    urlsSeen,
    reposFound: repos.length,
    inserted,
    alreadyKnown,
  };
}
