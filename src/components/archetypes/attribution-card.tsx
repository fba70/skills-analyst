import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Contributor } from "@/server/analytics/archetype";

/** How many credits are shown before the list is folded. */
const VISIBLE = 12;

/**
 * Attribution (Doc 2 R3.4) — who this guidance was learned from.
 *
 * Doc 1 promises contributors "attribution on category pages and archetypes", and an
 * archetype is derived work: the corpus is mirrored under other people's licences, and a
 * skeleton mined from it owes those repositories a credit whether or not any single line of
 * their text survives into it. Publishing the numbers without the names would be taking the
 * evidence and dropping the provenance.
 *
 * ## Counted in structures, and that is not the same as skills
 *
 * A source is credited for the distinct document **shapes** it contributed, because that is
 * the unit the mine measured in. One repository once supplied 89% of this corpus with 85% of
 * its skills sharing a single generated skeleton; crediting by skill count would put it at
 * the top of every list here having taught the archetype one thing.
 *
 * ## Pinned, not recomputed
 *
 * These names are stored on the archetype row beside the numbers they produced. Querying the
 * corpus at render time would be easier and would credit whoever is in it *today* for a
 * skeleton mined from whoever was in it when the version was cut — a provenance claim that
 * looks right and is not.
 */
export function AttributionCard({ contributors }: { contributors: Contributor[] }) {
  const shown = contributors.slice(0, VISIBLE);
  const rest = contributors.slice(VISIBLE);
  const curated = contributors.filter((c) => c.curated).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Derived from</CardTitle>
        <CardDescription>
          {contributors.length === 0 ? (
            <>Attribution was not recorded for this version.</>
          ) : (
            <>
              {contributors.length} source{contributors.length === 1 ? "" : "s"} contributed
              evidence to this archetype
              {curated > 0 ? <> · {curated} in the curated band it is contrasted against</> : null}.
              Credited by distinct document structures, the unit the mine measures in — not by
              skill count, which a single generator can dominate.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {contributors.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Versions mined before miner 2.1.0 stored their counts but not their contributors.
            The next mine of this category records them.
          </p>
        ) : (
          <>
            <ul className="grid gap-1.5">
              {shown.map((contributor) => (
                <ContributorRow key={contributor.source} contributor={contributor} />
              ))}
            </ul>

            {rest.length > 0 ? (
              <details className="group">
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm">
                  {rest.length} more source{rest.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 grid gap-1.5">
                  {rest.map((contributor) => (
                    <ContributorRow key={contributor.source} contributor={contributor} />
                  ))}
                </ul>
              </details>
            ) : null}

            <p className="text-muted-foreground border-t pt-3 text-xs">
              Each skill keeps its own upstream licence, which the registry entry records.
              Nothing here relicenses anything.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ContributorRow({ contributor }: { contributor: Contributor }) {
  const label = (
    <>
      <span className="min-w-0 truncate font-mono text-sm">{contributor.source}</span>
      {contributor.curated ? (
        <Badge variant="secondary" className="shrink-0 text-[11px]">
          curated
        </Badge>
      ) : null}
    </>
  );

  return (
    <li className="flex items-center gap-2">
      {contributor.url ? (
        <a
          href={contributor.url}
          target="_blank"
          rel="noreferrer noopener"
          className="hover:text-primary flex min-w-0 flex-1 items-center gap-2 transition-colors"
        >
          {label}
          <ExternalLink className="text-muted-foreground size-3 shrink-0" />
        </a>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
      )}
      <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
        {contributor.structures}
      </span>
    </li>
  );
}
