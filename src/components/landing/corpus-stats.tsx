import Link from "next/link";

import { LicenseBadge } from "@/components/registry/license-badge";
import { faqHref } from "@/lib/faq";
import type { PlatformStats } from "@/server/dal/stats";

/**
 * The corpus, on the front door (Doc 2 R8.5).
 *
 * The landing page makes a claim — that this corpus is validated and worth building from —
 * and until now the only evidence for it was three paragraphs asserting the same thing. A
 * visitor deciding whether to trust a registry wants the numbers, and R8.5 exists precisely
 * because Doc 2 specifies observability for operators (R1.7, R6.4) and researchers (R3.7)
 * and nothing at all for the person who just arrived.
 *
 * ## The numbers are chosen to be checkable, including the unflattering ones
 *
 * Pass rate sits next to the quarantine count; the download count sits next to the licence
 * mix that limits it; freshness is stated against R7.4's 24-hour target rather than as a
 * bare timestamp, so "6h ago" can be read as *inside target* by someone who has never heard
 * of R7.4. A statistics panel that can only ever look good is marketing with a table in it,
 * and this one is on the page that has the most reason to be believed.
 *
 * The clearest example is `sourcesSynced of sources`. Ingestion is a fraction done, so the
 * skill count is not the size of the corpus — it is the size *so far*. Printing the count
 * alone would be true and would overstate what has been reached.
 *
 * ## Presentation is deliberately not the dashboard's
 *
 * `/dashboard` renders the same `platformStats()` in Cards, which is right for an operator
 * surface sitting inside application chrome. Here the register is a marketing page: larger
 * numbers, no icons, and blocks that are tinted rather than framed — a full Card border
 * around each figure would put five boxes on the front door competing with the two
 * distributions below it. Sharing the query and not the components is the correct split:
 * the facts must not diverge, the framing should.
 */
export function CorpusStats({ stats }: { stats: PlatformStats }) {
  const withinTarget = stats.hoursSinceSync !== null && stats.hoursSinceSync < 24;

  return (
    <section className="grid gap-8">
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
          The corpus right now
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Live, not a snapshot. Ingestion is still running, so these numbers are what has
          been reached so far — {stats.sourcesSynced.toLocaleString()} of{" "}
          {stats.sources.toLocaleString()} sources have completed a sync.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
        <Figure
          value={stats.indexed.toLocaleString()}
          label="Skills indexed"
          detail="validated and browsable"
        />
        <Figure
          value={`${stats.passRate}%`}
          label="Passed validation"
          detail={`${stats.quarantined.toLocaleString()} quarantined`}
        />
        <Figure
          value={stats.downloadable.toLocaleString()}
          label="Downloadable"
          detail="licence permits redistribution"
        />
        <Figure
          value={
            stats.hoursSinceSync === null
              ? "—"
              : stats.hoursSinceSync < 1
                ? "just now"
                : `${stats.hoursSinceSync}h`
          }
          label="Since last sync"
          /*
           * The target is printed beside the measurement, not implied by it. "6h ago" is
           * only reassuring to someone who already knows what good looks like, and the
           * whole point of this panel is the reader who does not.
           */
          detail={
            stats.hoursSinceSync === null
              ? "no sync yet"
              : withinTarget
                ? "inside the 24h target"
                : "past the 24h target"
          }
        />
        {/*
          The one figure that is not a fact about the corpus.

          The four above count what came in; this counts what has been learned from it,
          which is the claim the third pillar makes and the only one the page could not
          previously back with a number. It is measured in **distinct structures** rather
          than skills because that is the unit the mine uses — quoting a skill count would
          inflate the evidence by exactly the factor the miner exists to divide out.
        */}
        <Figure
          value={`${stats.archetypeCategories} of ${stats.functionCategories}`}
          label="Archetypes mined"
          detail={`from ${stats.archetypeStructures.toLocaleString()} distinct structures`}
        />
      </dl>

      <div className="grid gap-10 sm:grid-cols-2 sm:gap-8">
        <Distribution
          title="Quality"
          note="Composite score per skill — structure, documentation, resource hygiene. Bands rather than an average, which over thousands of skills moves by a point a week and says nothing."
          rows={stats.qualityBands.map((row) => ({ key: row.band, label: row.band, count: row.count }))}
        />

        <Distribution
          title="Licences"
          note="What each licence lets us do with the content. The two “Mirrored” postures can be downloaded; the rest are indexed with a link to origin, because their licence does not permit us to redistribute the content."
          rows={stats.licenceMix.map((row) => ({
            key: row.posture,
            label: <LicenseBadge spdx={null} redistribution={row.posture} />,
            count: row.count,
          }))}
        />
      </div>

      {/*
        The way in, next to the number that earns it. A count of mined archetypes with no
        route to understanding one is the state this section was built to stop being in.

        It points at the FAQ rather than straight at `/archetypes`. Both are public, but the
        figure above is the one a first-time reader has least frame for — "12 of 13, from
        2,223 distinct structures" needs *what an archetype is* before it needs the list of
        them. The header carries the direct link for anyone who already knows.
      */}
      <p className="text-sm">
        <Link
          href={faqHref("archetypes")}
          className="hover:text-foreground underline underline-offset-4"
        >
          FAQ: what an archetype is, and how one is mined
        </Link>
      </p>

    </section>
  );
}

/**
 * One figure, as a block rather than as free-floating text.
 *
 * Five numbers side by side with nothing between them read as one run-on sentence: the eye
 * has to use the gap to work out where a value ends and the next label begins, and the gap
 * is the weakest separator there is. A tinted ground gives each one an edge to sit inside.
 *
 * The accent rule is on the **bottom** only, under the detail line, so it closes the block
 * instead of decorating it. A full border would make five equal boxes competing with the
 * distributions below; one weighted edge separates without adding a fifth frame to the page.
 *
 * `content-start` matters: the grid stretches every cell to the tallest, and without it a
 * two-line label would push its own value away from the top of the card while its
 * neighbours stayed put.
 */
function Figure({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <div className="bg-muted/40 border-primary/40 grid content-start gap-1 rounded-lg border-b-2 p-4">
      <dd className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
        {value}
      </dd>
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-muted-foreground text-xs">{detail}</dd>
    </div>
  );
}

type DistributionRow = { key: string; label: React.ReactNode; count: number };

/**
 * Proportional bars, scaled to the largest row rather than to the total.
 *
 * Scaling to the total makes every bar short whenever one band dominates — and one band
 * does dominate here, which would leave the reader unable to compare the other three at
 * all. The count is printed on every row, so the bar carries the comparison and the number
 * carries the fact.
 */
function Distribution({
  title,
  note,
  rows,
}: {
  title: string;
  note: string;
  rows: DistributionRow[];
}) {
  const largest = Math.max(1, ...rows.map((row) => row.count));

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <h3 className="font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing indexed yet.</p>
      ) : (
        <ul className="grid gap-4">
          {rows.map((row) => (
            <li key={row.key} className="grid gap-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {row.count.toLocaleString()}
                </span>
              </div>
              <div className="bg-muted h-1 w-full overflow-hidden rounded-full" aria-hidden>
                <div
                  className="bg-primary/70 h-full rounded-full"
                  style={{ width: `${Math.max(2, (row.count / largest) * 100)}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
