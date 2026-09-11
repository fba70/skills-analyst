import type { Metadata } from "next";
import { headers } from "next/headers";

import { ExplainLink } from "@/components/registry/explain";
import { SkillRow } from "@/components/registry/skill-row";
import { RegistryFilters } from "@/components/registry/registry-filters";
import { Paginator } from "@/components/common/paginator";
import { Card, CardContent } from "@/components/ui/card";
import {
  getFilterOptions,
  listSkills,
  PAGE_SIZES,
  SORTS,
  type PageSize,
  type SortKey,
} from "@/server/dal/skills";

export const metadata: Metadata = { title: "Registry" };

/**
 * The list is a server component and stays one: filters, sort, paging and counting are
 * all query-string in, SQL out. Nothing here fetches a row it does not render.
 */
export default async function RegistryPage(props: PageProps<"/skills">) {
  // No session check: the registry is public (R8.1). The DAL resolves scope on its own —
  // an anonymous request lands on the public corpus with RLS enforcing it.
  const params = await props.searchParams;

  const single = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const requestedSize = Number(single("size"));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(requestedSize)
    ? (requestedSize as PageSize)
    : undefined;
  const sortParam = single("sort");
  const sort = sortParam && sortParam in SORTS ? (sortParam as SortKey) : undefined;

  const filters = {
    query: single("q"),
    source: single("source"),
    dialect: single("dialect"),
    posture: single("posture"),
    capability: single("capability"),
    // One value from the sidebar select, handed over as the list `listSkills` takes — the
    // filter is any-of, and an MCP caller sends several through the same parameter.
    tools: single("tool") ? [single("tool") as string] : undefined,
    category: single("category"),
    sort,
    page: Number(single("page")) || 1,
    pageSize,
  };

  const [result, options] = await Promise.all([listSkills(filters), getFilterOptions()]);

  /**
   * What the reader looked for, and whether the corpus had it (RK.5, plan step E3).
   *
   * ## Only page one, and only a real query
   *
   * Paging is the same search asked again, so counting page three would triple one person's
   * demand — and the result count on page three is the same total anyway. `recordSearch`
   * normalises and drops anything too short to be a query rather than a keystroke on the way to
   * one.
   *
   * ## Awaited, not fired and forgotten
   *
   * A detached promise in a server component is a promise the runtime may tear down with the
   * response — the same reason the interview route wraps its persistence in `after()`. The insert
   * is a single indexed upsert and the recorder swallows its own failures, so awaiting it costs a
   * millisecond and cannot fail the page.
   *
   * ## The caller key is the forwarding IP, and it is never stored
   *
   * The first version passed `null`, reasoning that under-counting distinct searchers is the safe
   * direction for a privacy floor. It is not — `callerDigest(null)` returns one shared constant,
   * so **every anonymous search would collapse to a single digest and the floor of five could
   * never be reached**. The board would have been permanently empty on its main surface, for a
   * reason that looked like caution.
   *
   * So it is the same identity the download route and the public write limiter already use: the
   * forwarded address, hashed with a daily-rotating salt before anything is written, and the
   * address itself never stored anywhere. Shared behind a NAT and rotated at will, which makes it
   * a *weak* identity — and weak is right here, because the digest exists to stop one person
   * being counted five times, not to know who anybody is.
   */
  if (result.page === 1) {
    const { recordSearch } = await import("@/server/analytics/demand");
    const requestHeaders = await headers();
    await recordSearch({
      query: filters.query,
      resultCount: result.total,
      channel: "web",
      callerKey:
        requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        requestHeaders.get("x-real-ip") ??
        null,
    });
  }
  const first = (result.page - 1) * result.pageSize + 1;
  const last = Math.min(result.page * result.pageSize, result.total);

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Registry</h1>
        <p className="text-muted-foreground">
          {options.total} validated skill{options.total === 1 ? "" : "s"} · {options.mirrored}{" "}
          mirrored, {options.total - options.mirrored} indexed by metadata only. Nothing
          appears here until it has passed validation.
        </p>
      </div>

      <RegistryFilters options={options} pageSizes={PAGE_SIZES} sorts={SORTS} />

      {/*
        One link, not per-badge.
        
        Each result below is wrapped in a card-level <Link> to the skill, and an anchor
        inside an anchor is invalid HTML — browsers disagree about what the click means and
        the card's own navigation stops being predictable. The detail pages wrap their
        badges individually because nothing wraps them there.
      */}
      <p>
        <ExplainLink anchor="quality">
          What do the scores, licences and badges mean?
        </ExplainLink>
      </p>

      {result.total === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            Nothing matches these filters.
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Showing {first}–{last} of {result.total}
          </p>

          <ul className="grid gap-3">
            {result.items.map((skill) => (
              <li key={skill.id}>
                <SkillRow skill={skill} />
              </li>
            ))}
          </ul>

          <Paginator
            page={result.page}
            pageCount={result.pageCount}
            basePath="/skills"
            searchParams={params}
          />
        </>
      )}
    </div>
  );
}
