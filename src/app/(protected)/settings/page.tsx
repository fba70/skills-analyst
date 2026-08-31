import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Paginator } from "@/components/common/paginator";
import { IngestionPanel } from "@/components/settings/ingestion-panel";
import { ArchetypePanel } from "@/components/settings/archetype-panel";
import { PipelinePanel } from "@/components/settings/pipeline-panel";
import { ListControls, SettingsTabs } from "@/components/settings/list-controls";
import { QuarantinePanel } from "@/components/settings/quarantine-panel";
import { ReviewPanel } from "@/components/settings/review-panel";
import { SourcesPanel } from "@/components/settings/sources-panel";
import { LoopPanel } from "@/components/settings/loop-panel";
import { RateLimitPanel } from "@/components/settings/rate-limit-panel";
import { SchedulePanel } from "@/components/settings/schedule-panel";
import { SpendPanel } from "@/components/settings/spend-panel";
import { SubmitPanel } from "@/components/settings/submit-panel";
import { TakedownPanel } from "@/components/settings/takedown-panel";
import { TaxonomyPanel } from "@/components/settings/taxonomy-panel";
import { UsersPanel } from "@/components/settings/users-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { discoveryPolicy } from "@/server/crawl/policy";
import { crawlCoverage } from "@/server/crawl/run";
import { sourceDiversity } from "@/server/analytics/templates";
import { archetypeSummary } from "@/server/analytics/archetype-run";
import { archetypeActivity, loopEvents, loopMetrics } from "@/server/analytics/loop";
import { getRateLimits } from "@/server/settings/rate-limits";
import { getSchedule, stageDue } from "@/server/settings/schedule";
import { budgetState, spendBreakdown } from "@/server/billing/spend";
import { listTakedowns, takedownCounts } from "@/server/compliance/takedown";
import { pipelineBacklog, recentRuns } from "@/server/pipeline/run";
import { staleSlices } from "@/server/validation/rescan";
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
  "archetypes",
  "submit",
  "taxonomy",
  "review",
  "quarantine",
  "sources",
  "takedowns",
  "spend",
  "loop",
  "schedule",
  "limits",
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

  const [counts, coverage, curation, takedowns] = await Promise.all([
    platformCounts(),
    crawlCoverage(),
    curationCounts(),
    takedownCounts(),
  ]);

  const shardTotals = coverage.shards.reduce(
    (totals, row) => ({ shards: totals.shards + row.shards, seen: totals.seen + row.seen }),
    { shards: 0, seen: 0 },
  );

  // Only the visible tab's data is loaded.
  const [held, quarantined, sourceHealth, users, taxonomy, queue, diversity, freshness, backlog, runs, archetypeList, takedownList, platformBudget, breakdown, metrics, activity, loopLog, schedule, rateLimits] =
    await Promise.all([
    tab === "review" ? listHeldRepos(query) : null,
    tab === "quarantine" ? listQuarantined(query) : null,
    tab === "sources" ? listSourceHealth(query) : null,
    tab === "users" ? listPlatformUsers(query) : null,
    tab === "taxonomy" ? taxonomySummary() : null,
    tab === "taxonomy" ? reviewQueue(query) : null,
    tab === "submit" ? sourceDiversity(12) : null,
    tab === "ingestion" ? staleSlices() : null,
    tab === "ingestion" ? pipelineBacklog() : null,
    tab === "ingestion" ? recentRuns(8) : null,
    tab === "archetypes" ? archetypeSummary() : null,
    tab === "takedowns" ? listTakedowns(query) : null,
    tab === "spend" ? budgetState("corpus_taxonomy", null) : null,
    tab === "spend" ? spendBreakdown() : null,
    tab === "loop" ? loopMetrics() : null,
    tab === "loop" ? archetypeActivity() : null,
    tab === "loop" ? loopEvents() : null,
    tab === "schedule" ? getSchedule() : null,
    tab === "limits" ? getRateLimits() : null,
  ]);

  // Every tab except Ingestion is a paginated list.
  // The taxonomy queue joins the paginated lists. It is 1,130 deep, and showing 20 of it
  // with no total was what made a correct decision look like it had been undone.
  const paged = held ?? quarantined ?? sourceHealth ?? users ?? takedownList ?? queue;

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
          { value: "archetypes", label: "Archetypes" },
          { value: "review", label: `Review (${curation.held})` },
          { value: "quarantine", label: `Quarantine (${curation.quarantined})` },
          { value: "sources", label: "Sources" },
          { value: "loop", label: "Loop" },
          { value: "schedule", label: "Schedule" },
          { value: "limits", label: "Rate limits" },
          { value: "spend", label: "Spend" },
          {
            value: "takedowns",
            // The open count is in the label because an unanswered notice has a clock on
            // it in a way a quarantined skill does not.
            label: takedowns.open > 0 ? `Takedowns (${takedowns.open})` : "Takedowns",
          },
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

        {tab === "ingestion" ? (
          <div className="grid gap-6">
            <PipelinePanel
              freshness={freshness ?? []}
              backlog={
                backlog ?? {
                  sourcesAwaitingSync: 0,
                  awaitingValidation: 0,
                  awaitingFingerprint: 0,
                  awaitingSignature: 0,
                }
              }
              runs={(runs ?? []).map((run) => ({
                at: run.at.toISOString(),
                ok: run.ok,
                trigger: run.trigger,
                elapsedMs: run.elapsedMs,
                stages: run.stages,
              }))}
              // Presence of the secret is what actually gates the cron route, so it is the
              // honest thing to report — a schedule in vercel.ts that 401s is not enabled.
              cronEnabled={Boolean(process.env.CRON_SECRET)}
            />
            <div className="grid gap-2">
              <h2 className="text-sm font-medium">Individual stages</h2>
              <IngestionPanel />
            </div>
          </div>
        ) : null}
        {tab === "schedule" && schedule ? (
          <SchedulePanel
            schedule={schedule}
            status={{
              pipeline: await stageDue("pipeline", schedule),
              archetypes: await stageDue("archetypes", schedule),
            }}
          />
        ) : null}

        {/* R8.8's limit, as a setting. The panel says which scope is actually in effect. */}
        {tab === "limits" && rateLimits ? <RateLimitPanel limits={rateLimits} /> : null}

        {tab === "loop" && metrics && activity && loopLog ? (
          <LoopPanel metrics={metrics} activity={activity} events={loopLog} />
        ) : null}

        {tab === "spend" && platformBudget && breakdown ? (
          <SpendPanel platform={platformBudget} breakdown={breakdown} />
        ) : null}

        {tab === "takedowns" ? (
          <TakedownPanel takedowns={takedownList?.items ?? []} />
        ) : null}

        {tab === "archetypes" ? (
          <ArchetypePanel
            archetypes={(archetypeList ?? []).map((row) => {
              const skeleton = row.skeleton as {
                sections?: Array<{ role: string; lift: number; required: boolean }>;
              };
              return {
                category: row.category,
                version: row.version,
                skillCount: row.skillCount,
                distinctStructures: row.distinctStructures,
                sourceCount: row.sourceCount,
                sections: skeleton.sections ?? [],
                antiPatterns: (row.antiPatterns as Array<{ label: string; lift: number }>) ?? [],
              };
            })}
          />
        ) : null}
        {tab === "submit" ? (
          <SubmitPanel
            diversity={diversity ?? []}
            minDiversityPercent={discoveryPolicy.minStructuralDiversityPercent}
          />
        ) : null}
        {tab === "taxonomy" && taxonomy && queue ? (
          <TaxonomyPanel
            coverage={taxonomy.counts}
            queue={queue.items}
            queueTotal={queue.total}
            totals={taxonomy.totals}
            remaining={taxonomy.remaining}
            notClassifiable={taxonomy.notClassifiable}
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
