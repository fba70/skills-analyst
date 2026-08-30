import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Paginator } from "@/components/common/paginator";
import { IngestionPanel } from "@/components/settings/ingestion-panel";
import { ListControls, SettingsTabs } from "@/components/settings/list-controls";
import { QuarantinePanel } from "@/components/settings/quarantine-panel";
import { ReviewPanel } from "@/components/settings/review-panel";
import { SourcesPanel } from "@/components/settings/sources-panel";
import { SubmitPanel } from "@/components/settings/submit-panel";
import { TaxonomyPanel } from "@/components/settings/taxonomy-panel";
import { UsersPanel } from "@/components/settings/users-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { discoveryPolicy } from "@/server/crawl/policy";
import { crawlCoverage } from "@/server/crawl/run";
import { sourceDiversity } from "@/server/analytics/templates";
import { isAdmin, listPlatformUsers, platformCounts } from "@/server/dal/admin";
import {
  curationCounts,
  listHeldRepos,
  listQuarantined,
  listSourceHealth,
} from "@/server/dal/curation";
import { ADMIN_PAGE_SIZES } from "@/server/dal/paging";
import { requireSession } from "@/server/dal/session";
import { MAX_BATCH } from "@/server/taxonomy/classify";
import { ARCHETYPE_THRESHOLD, reviewQueue, taxonomySummary } from "@/server/taxonomy/run";

export const metadata: Metadata = { title: "Settings" };

const TABS = [
  "ingestion",
  "submit",
  "taxonomy",
  "review",
  "quarantine",
  "sources",
  "users",
] as const;
type Tab = (typeof TABS)[number];

/**
 * System-admin settings.
 *
 * Guarded three times over: the sidebar only offers the link to admins, this page
 * `notFound()`s for everyone else, and every action re-checks on the server.
 *
 * The active tab lives in the URL, which buys two things. Paging a queue no longer throws
 * you back to the first tab, and — the reason that matters at scale — **only the visible
 * tab is queried**. Fetching all five lists on every render was five queries to render one.
 */
export default async function SettingsPage(props: PageProps<"/settings">) {
  const session = await requireSession();
  if (!(await isAdmin())) notFound();

  const params = await props.searchParams;
  const single = (key: string) => {
    const value = params[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const requested = single("tab");
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? "")
    ? (requested as Tab)
    : "ingestion";
  const query = { page: Number(single("page")) || 1, pageSize: Number(single("size")) || undefined };

  const [counts, coverage, curation] = await Promise.all([
    platformCounts(),
    crawlCoverage(),
    curationCounts(),
  ]);

  const shardTotals = coverage.shards.reduce(
    (totals, row) => ({ shards: totals.shards + row.shards, seen: totals.seen + row.seen }),
    { shards: 0, seen: 0 },
  );

  // Only the visible tab's data is loaded.
  const [held, quarantined, sourceHealth, users, taxonomy, queue, diversity] = await Promise.all([
    tab === "review" ? listHeldRepos(query) : null,
    tab === "quarantine" ? listQuarantined(query) : null,
    tab === "sources" ? listSourceHealth(query) : null,
    tab === "users" ? listPlatformUsers(query) : null,
    tab === "taxonomy" ? taxonomySummary() : null,
    tab === "taxonomy" ? reviewQueue(20) : null,
    tab === "submit" ? sourceDiversity(12) : null,
  ]);

  // Every tab except Ingestion is a paginated list.
  const paged = held ?? quarantined ?? sourceHealth ?? users;

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Settings</h1>
          <Badge variant="default">system admin</Badge>
        </div>
        <p className="text-muted-foreground">
          Platform-wide administration. Distinct from workspace roles: this reaches every
          user and the ingestion pipeline.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Users" value={counts.users} detail={`${counts.admins} admin`} />
        <Stat label="Workspaces" value={counts.organizations} />
        <Stat
          label="Crawl shards"
          value={shardTotals.shards}
          detail={`${shardTotals.seen.toLocaleString()} markers seen`}
        />
        <Stat
          label="Awaiting review"
          value={curation.held}
          detail={`${curation.disabledSources} source(s) disabled`}
        />
        <Stat label="Quarantined" value={curation.quarantined} detail="invisible in search" />
      </div>

      <SettingsTabs
        active={tab}
        tabs={[
          { value: "ingestion", label: "Ingestion" },
          { value: "submit", label: "Add source" },
          { value: "taxonomy", label: "Taxonomy" },
          { value: "review", label: `Review (${curation.held})` },
          { value: "quarantine", label: `Quarantine (${curation.quarantined})` },
          { value: "sources", label: "Sources" },
          { value: "users", label: `Users (${counts.users})` },
        ]}
      >
        <div className="grid min-w-0 gap-4">
        {paged ? (
          <ListControls
            pageSizes={ADMIN_PAGE_SIZES}
            total={paged.total}
            showing={{
              first: (paged.page - 1) * paged.pageSize + 1,
              last: Math.min(paged.page * paged.pageSize, paged.total),
            }}
          />
        ) : null}

        {tab === "ingestion" ? <IngestionPanel /> : null}
        {tab === "submit" ? (
          <SubmitPanel
            diversity={diversity ?? []}
            minDiversityPercent={discoveryPolicy.minStructuralDiversityPercent}
          />
        ) : null}
        {tab === "taxonomy" && taxonomy && queue ? (
          <TaxonomyPanel
            coverage={taxonomy.counts}
            queue={queue}
            totals={taxonomy.totals}
            remaining={taxonomy.remaining}
            archetypeThreshold={ARCHETYPE_THRESHOLD}
            maxBatch={MAX_BATCH}
          />
        ) : null}
        {tab === "review" && held ? <ReviewPanel repos={held.items} /> : null}
        {tab === "quarantine" && quarantined ? (
          <QuarantinePanel versions={quarantined.items} />
        ) : null}
        {tab === "sources" && sourceHealth ? (
          <SourcesPanel
            sources={sourceHealth.items}
            total={sourceHealth.total}
            stale={sourceHealth.stale}
            disabled={sourceHealth.disabled}
          />
        ) : null}
        {tab === "users" && users ? (
          <Card>
            <CardContent className="px-0 sm:px-(--card-spacing)">
              <UsersPanel users={users.items} currentUserId={session.user.id} />
            </CardContent>
          </Card>
        ) : null}

        {paged ? (
          <Paginator
            page={paged.page}
            pageCount={paged.pageCount}
            basePath="/settings"
            searchParams={params}
          />
        ) : null}
        </div>
      </SettingsTabs>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <Card>
      <CardContent className="grid gap-1">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}
