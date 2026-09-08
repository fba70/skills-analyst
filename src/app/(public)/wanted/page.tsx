import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { demandLabel, LOW_RESULT_THRESHOLD, MIN_DISTINCT_SEARCHERS } from "@/lib/demand";
import { demandSummary, mostWanted } from "@/server/analytics/demand";

export const metadata: Metadata = {
  title: "Most wanted",
  description: "What people came to the registry looking for and did not find.",
};

/**
 * The most-wanted board (Doc 6 RK.5, plan step E3).
 *
 * ## The only page here about what the corpus does not contain
 *
 * Every other surface reads the corpus: archetypes describe what people wrote, similarity
 * describes what exists, the trust surfaces describe what passed. None can see the thing a reader
 * came for and left without, and that is the one signal that says *build this*.
 *
 * Public, and in the `(public)` group beside the registry and the archetypes, for the reason Doc 1
 * gives about archetype snapshots: it is the argument for the platform rather than a thing to
 * sell. A gap nobody can see is a gap nobody fills.
 *
 * ## Nothing appears until enough separate people asked
 *
 * A search query is user-typed text and this page is public — `"review our acme corp msa"` is a
 * demand signal and also somebody's Monday morning. The distinct-searcher floor is applied in SQL
 * and re-applied on the way out, and the page says so, because a reader who does not know a floor
 * exists cannot tell an empty board from a private one.
 */
export default async function WantedPage() {
  const [rows, summary] = await Promise.all([mostWanted({ limit: 40 }), demandSummary()]);

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Most wanted</h1>
        <p className="text-muted-foreground max-w-3xl">
          What people searched the registry for and did not find. Everything else on this site
          describes what the corpus contains; this is the only page about what it does not — and
          it is the only measurement here that says what to build next.
        </p>
      </div>

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">Nothing to show yet</CardTitle>
            <CardDescription>
              {summary.searches === 0
                ? "No searches have been recorded yet, so this is the absence of data rather than the absence of gaps."
                : `${summary.searches.toLocaleString()} searches recorded across ${summary.distinctQueries.toLocaleString()} distinct queries, and none has yet been asked by ${MIN_DISTINCT_SEARCHERS} separate people while returning ${LOW_RESULT_THRESHOLD} results or fewer.`}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Search className="size-4" />
              {rows.length} unanswered {rows.length === 1 ? "search" : "searches"}
            </CardTitle>
            <CardDescription>
              Ranked by how many separate people asked. A query reaches this page only after{" "}
              {MIN_DISTINCT_SEARCHERS} distinct searchers, so nothing here describes one
              person&rsquo;s work.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {rows.map((row) => (
              <div
                key={row.query}
                className="flex min-w-0 flex-wrap items-baseline gap-2 rounded-md border p-3"
              >
                <span className="min-w-0 text-sm">{row.query}</span>
                <Badge
                  variant={demandLabel(row.medianResults) === "unmet" ? "secondary" : "outline"}
                >
                  {demandLabel(row.medianResults) === "unmet"
                    ? "nothing found"
                    : `${row.medianResults} found`}
                </Badge>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                  {row.searchers} people · {row.searches} searches
                </span>
                {/*
                  A link into the registry with the query pre-filled. The point is not that they
                  will find it — the board exists because they will not — it is that somebody
                  deciding whether to write it needs to see for themselves what is there now.
                */}
                <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 text-xs">
                  <Link href={`/skills?q=${encodeURIComponent(row.query)}`}>See what exists</Link>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-muted-foreground text-xs">
        {/*
          What is withheld, and why. Without it an empty or short board reads as "the corpus is
          complete" — the misreading `archetypes --blocks` produced at 1% coverage.
        */}
        Recorded since{" "}
        {summary.since ? summary.since.toISOString().slice(0, 10) : "collection began"}.
        Queries are normalised and stored without any identity — no account, no address, no token
        — so this board cannot say who wanted anything, only how many separate people did.{" "}
        {summary.aboveFloor - rows.length > 0
          ? `${summary.aboveFloor - rows.length} other queries clear the floor and are not shown because the corpus already answers them.`
          : ""}
      </p>
    </div>
  );
}
