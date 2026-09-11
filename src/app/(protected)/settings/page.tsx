import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Paginator } from "@/components/common/paginator";
import { IngestionPanel } from "@/components/settings/ingestion-panel";
import { ArchetypePanel } from "@/components/settings/archetype-panel";
import { PipelinePanel } from "@/components/settings/pipeline-panel";
import { ListControls, SettingsTabs } from "@/components/settings/list-controls";
import { FlagsPanel } from "@/components/settings/flags-panel";
import { FreshnessPanel } from "@/components/settings/freshness-panel";
import { PlansPanel, type PlanRow } from "@/components/settings/plans-panel";
import { QuarantinePanel } from "@/components/settings/quarantine-panel";
import { ReviewPanel } from "@/components/settings/review-panel";
import { SourcesPanel } from "@/components/settings/sources-panel";
import { LoopPanel } from "@/components/settings/loop-panel";
import { MaintainersPanel } from "@/components/settings/maintainers-panel";
import { rateFor } from "@/lib/llm-pricing";
import { ModelsPanel } from "@/components/settings/models-panel";
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
import { DUE_SOON_DAYS } from "@/lib/freshness";
import { dueForReview } from "@/server/skills/lifecycle";
import { versionSummaryView } from "@/server/skills/drift-read";
import { linkCheckSummary, rottenLinks } from "@/server/skills/links";
import { MODEL_TASKS } from "@/lib/models";
import { getModelSettings } from "@/server/settings/models";
import { getRateLimits } from "@/server/settings/rate-limits";
import { getSchedule, stageDue } from "@/server/settings/schedule";
import { budgetState, spendBreakdown } from "@/server/billing/spend";
import { mcpUsageSummary } from "@/server/mcp/usage";
import { listTakedowns, takedownCounts } from "@/server/compliance/takedown";
import { pipelineBacklog, recentRuns, type PipelineBacklog } from "@/server/pipeline/run";
import { readHeartbeat } from "@/server/pipeline/heartbeat";
import { staleSlices } from "@/server/validation/rescan";
import { planRoster as listPlanRoster } from "@/server/dal/entitlements";
import { outcomeSummary } from "@/server/analytics/outcomes";
import { flagQueue, flagSummary } from "@/server/curation/flags";
import { listMaintainers, maintainerSummary } from "@/server/curation/maintainers";
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
import { MIN_SOURCES, MIN_STRUCTURES } from "@/server/analytics/archetype";
import { reviewQueue, taxonomySummary } from "@/server/taxonomy/run";
import { DOMAINS, FUNCTIONS } from "@/server/taxonomy/vocabulary";

export const metadata: Metadata = { title: "Settings" };

/**
 * What "nothing is queued" looks like, defined once.
 *
 * Both the pipeline card and the individual stages need a fallback for the tab where the
 * backlog was not fetched. Two literals would be two things to update the next time a stage
 * is added, and the one that got missed would quietly show a zero denominator rather than a
 * real one.
 */
const NO_BACKLOG: PipelineBacklog = {
  sourcesAwaitingSync: 0,
  awaitingValidation: 0,
  awaitingFingerprint: 0,
  awaitingSignature: 0,
  shardsPending: 0,
  reposAwaitingDecision: 0,
  skillsAwaitingAudit: 0,
};

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
  "freshness",
  "schedule",
  "limits",
  "models",
  "flags",
  "maintainers",
  "plans",
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

  /**
   * Unconditional, because every tab *label* is rendered whichever tab is active, and two of
   * them carry an open count. A count fetched only when its own tab is showing is a count
   * nobody sees until they have already gone looking.
   */
  const [counts, coverage, curation, takedowns, flagCounts, dueCount] = await Promise.all([
    platformCounts(),
    crawlCoverage(),
    curationCounts(),
    takedownCounts(),
    flagSummary(),
    /*
     * Loaded whatever tab is open, like the flag and takedown counts, because it is in the tab
     * label — and an overdue skill is already being shown to readers as stale, which is the
     * property that earns a number on a tab nobody has clicked.
     */
    dueForReview(DUE_SOON_DAYS, 200),
  ]);

  const shardTotals = coverage.shards.reduce(
    (totals, row) => ({ shards: totals.shards + row.shards, seen: totals.seen + row.seen }),
    { shards: 0, seen: 0 },
  );

  // Only the visible tab's data is loaded.
  const [held, quarantined, sourceHealth, users, taxonomy, queue, diversity, freshness, backlog, runs, heartbeat, archetypeList, takedownList, planRoster, outcomes, flags, platformBudget, breakdown, mcpUsage, metrics, activity, loopLog, linkRot, linkCoverage, trackedVersions, schedule, rateLimits, models, maintainerRoster, maintainerCounts] =
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
    tab === "ingestion" ? readHeartbeat() : null,
    tab === "archetypes" ? archetypeSummary() : null,
    tab === "takedowns" ? listTakedowns(query) : null,
    tab === "plans" ? listPlanRoster() : null,
    tab === "loop" ? outcomeSummary() : null,
    tab === "flags" ? flagQueue("received") : null,
    tab === "spend" ? budgetState("corpus_taxonomy", null) : null,
    tab === "spend" ? spendBreakdown() : null,
    tab === "spend" ? mcpUsageSummary() : null,
    tab === "loop" ? loopMetrics() : null,
    tab === "loop" ? archetypeActivity() : null,
    tab === "loop" ? loopEvents() : null,
    tab === "freshness" ? rottenLinks(50) : null,
    tab === "freshness" ? linkCheckSummary() : null,
    tab === "freshness" ? versionSummaryView() : null,
    tab === "schedule" ? getSchedule() : null,
    tab === "limits" ? getRateLimits() : null,
    tab === "models" ? getModelSettings() : null,
    tab === "maintainers" ? listMaintainers({ includeRevoked: true }) : null,
    tab === "maintainers" ? maintainerSummary() : null,
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
          {
            value: "freshness",
            /*
             * The overdue count is in the label, like Flags and Takedowns and for the same
             * reason: an overdue skill is already being shown to readers as stale, so it has a
             * clock on it in a way a quarantined one does not.
             */
            label: dueCount.length > 0 ? `Freshness (${dueCount.length})` : "Freshness",
          },
          { value: "schedule", label: "Schedule" },
          { value: "limits", label: "Rate limits" },
          { value: "spend", label: "Spend" },
          {
            value: "flags",
            // The open count is in the label for the same reason the takedown one is: a
            // reader's report has a clock on it in a way a quarantined skill does not.
            label: flagCounts.open > 0 ? `Flags (${flagCounts.open})` : "Flags",
          },
          { value: "maintainers", label: "Maintainers" },
          { value: "plans", label: "Plans" },
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
              backlog={backlog ?? NO_BACKLOG}
              heartbeat={
                heartbeat
                  ? {
                      stage: heartbeat.stage,
                      detail: heartbeat.detail,
                      secondsSinceBeat: heartbeat.secondsSinceBeat,
                      stale: heartbeat.stale,
                    }
                  : null
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
              {/* The same backlog the pipeline card reads, so a stage's denominator and the
                  pass summary above it cannot disagree about what is queued. */}
              <IngestionPanel
                backlog={backlog ?? NO_BACKLOG}
              />
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
        {/*
          Rates are resolved here rather than in the panel: `llm-pricing` is the module
          billing reads, and a client component asking it for a number would be a second
          copy of the price table shipped to the browser.
        */}
        {tab === "models" && models ? (
          <ModelsPanel
            models={models}
            rates={Object.fromEntries(
              MODEL_TASKS.map((task) => [models[task], rateFor(models[task]).inputPerMTok]),
            )}
          />
        ) : null}

        {tab === "freshness" && linkRot && linkCoverage ? (
          <FreshnessPanel
            /* Serialised at the boundary into a client component, as the plans panel does. */
            due={dueCount.map((row) => ({
              id: row.id,
              slug: row.slug,
              name: row.name,
              reviewBy: row.reviewBy?.toISOString() ?? null,
            }))}
            rotten={linkRot.map((row) => ({
              ...row,
              firstFailedAt: row.firstFailedAt?.toISOString() ?? null,
            }))}
            coverage={{
              versionsChecked: linkCoverage.versionsChecked,
              servable: linkCoverage.servable,
              links: linkCoverage.links,
              blocked: linkCoverage.blocked,
              unreachable: linkCoverage.unreachable,
            }}
            /*
              Already serialised and aged by the reader boundary, so this passes straight
              through — including `null`, which is the absent-table case and makes the section
              print the command rather than an empty table.
            */
            versions={trackedVersions}
          />
        ) : null}

        {tab === "loop" && metrics && activity && loopLog && outcomes ? (
          <LoopPanel
            metrics={metrics}
            activity={activity}
            events={loopLog}
            outcomes={outcomes.byKind}
            outcomeTotals={outcomes.totals}
            outcomeEligible={outcomes.eligible}
            unimplementedKinds={outcomes.unimplemented}
          />
        ) : null}

        {tab === "spend" && platformBudget && breakdown ? (
          <SpendPanel platform={platformBudget} breakdown={breakdown} mcp={mcpUsage} />
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
            evidence={taxonomy.evidence}
            minable={taxonomy.readyForArchetype}
            minStructures={MIN_STRUCTURES}
            minSources={MIN_SOURCES}
            stale={taxonomy.stale}
            priorCounts={taxonomy.priorCounts}
            currentVersion={taxonomy.currentVersion}
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
        {tab === "flags" && flags ? (
          <FlagsPanel
            rows={flags.map((row) => ({
              id: row.id,
              slug: row.slug,
              name: row.name,
              skillStatus: row.skillStatus,
              reason: row.reason,
              note: row.note,
              contact: row.contact,
              // Serialised at the boundary into a client component, as the plans panel does.
              createdAt: row.createdAt.toISOString(),
              stale: row.stale,
            }))}
          />
        ) : null}
        {tab === "maintainers" && maintainerRoster && maintainerCounts ? (
          <MaintainersPanel
            rows={maintainerRoster.map((row) => ({
              userId: row.userId,
              name: row.name,
              axis: row.axis,
              category: row.category,
              categoryLabel: row.categoryLabel,
              note: row.note,
              // Serialised at the boundary into a client component, like every panel here.
              since: row.since.toISOString(),
              revokedAt: row.revokedAt?.toISOString() ?? null,
            }))}
            options={{
              function: FUNCTIONS.map((c) => ({ id: c.id, label: c.label })),
              domain: DOMAINS.map((c) => ({ id: c.id, label: c.label })),
            }}
            summary={maintainerCounts}
            /*
             * Computed from the real vocabulary against the live roster, so a category added to
             * `vocabulary.ts` shows up here as uncovered on the next render rather than waiting
             * for somebody to notice. The same reason the FAQ imports its constants.
             */
            uncovered={[
              ...FUNCTIONS.filter(
                (c) =>
                  !maintainerRoster.some(
                    (row) => !row.revokedAt && row.axis === "function" && row.category === c.id,
                  ),
              ).map((c) => ({ axis: "function" as const, label: c.label })),
              ...DOMAINS.filter(
                (c) =>
                  !maintainerRoster.some(
                    (row) => !row.revokedAt && row.axis === "domain" && row.category === c.id,
                  ),
              ).map((c) => ({ axis: "domain" as const, label: c.label })),
            ]}
          />
        ) : null}
        {tab === "plans" && planRoster ? (
          <PlansPanel
            rows={planRoster.map(
              (row): PlanRow => ({
                organizationId: row.organizationId,
                name: row.name,
                slug: row.slug,
                plan: row.plan,
                note: row.note,
                // Serialised here rather than in the panel: the boundary into a client
                // component is the right place to stop passing Date objects around.
                validUntil: row.validUntil ? row.validUntil.toISOString() : null,
                members: row.members,
              }),
            )}
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
