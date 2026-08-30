import type { Metadata } from "next";
import Link from "next/link";

import { LicenseBadge } from "@/components/registry/license-badge";
import { labelFor } from "@/server/taxonomy/vocabulary";
import { RegistryFilters } from "@/components/registry/registry-filters";
import { Paginator } from "@/components/common/paginator";
import { Badge } from "@/components/ui/badge";
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
    category: single("category"),
    sort,
    page: Number(single("page")) || 1,
    pageSize,
  };

  const [result, options] = await Promise.all([listSkills(filters), getFilterOptions()]);
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
                <Link
                  href={`/skills/${skill.slug}`}
                  className="hover:border-primary/50 focus-visible:ring-ring block rounded-xl outline-hidden focus-visible:ring-2"
                >
                  <Card className="transition-colors">
                    <CardContent className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="font-medium">{skill.name}</span>
                        <QualityScore score={skill.qualityScore} />
                        <LicenseBadge
                          redistribution={skill.redistribution}
                          spdx={skill.licenseSpdx}
                        />
                        {skill.categories
                          .filter((c) => c.axis === "function")
                          .slice(0, 1)
                          .map((c) => (
                            <Badge key={c.value} variant="secondary">
                              {labelFor("function", c.value)}
                            </Badge>
                          ))}
                        {skill.categories
                          .filter((c) => c.axis === "domain")
                          .slice(0, 1)
                          .map((c) => (
                            <Badge key={c.value} variant="outline">
                              {labelFor("domain", c.value)}
                            </Badge>
                          ))}
                        {skill.variantCount > 0 ? (
                          <Badge variant="outline" className="text-muted-foreground text-xs">
                            +{skill.variantCount} near-duplicate
                            {skill.variantCount === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                        {skill.stars !== null ? (
                          <span className="text-muted-foreground text-xs">
                            ★ {skill.stars.toLocaleString()}
                          </span>
                        ) : null}
                      </div>
                      {skill.summary ? (
                        <p className="text-muted-foreground line-clamp-2 text-sm">
                          {skill.summary}
                        </p>
                      ) : null}
                      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                        <span>{skill.sourceName}</span>
                        <span>{skill.dialect.replace(/_/g, " ")}</span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
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

/**
 * Quality leads the default sort and appears on every row (Doc 2 R2.9): popularity must
 * never outrank a failed or unscored skill, so stars stay the quietest element here.
 */
function QualityScore({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <Badge variant="outline" className="text-muted-foreground text-xs">
        unscored
      </Badge>
    );
  }
  const tone =
    score >= 90
      ? "text-primary border-primary/40 bg-primary/10"
      : score >= 70
        ? "text-amber-600 border-amber-500/40 bg-amber-500/10 dark:text-amber-400"
        : "text-destructive border-destructive/40 bg-destructive/10";
  return (
    <Badge variant="outline" className={`text-xs font-medium ${tone}`}>
      {score}/100
    </Badge>
  );
}
