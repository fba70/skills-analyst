import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Download, PackageSearch, Sparkles } from "lucide-react";

import { LicenseBadge } from "@/components/registry/license-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/server/dal/session";
import { mySkills, platformStats } from "@/server/dal/stats";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The user's landing page (Doc 2 R8.5).
 *
 * Two halves, in the order a person cares about them: what is in the corpus, and what is
 * mine. The second is empty for everyone today because the builder (R4.x) does not exist —
 * it is queried against the real table anyway, so the section fills in on its own when it
 * does rather than needing to be rebuilt.
 *
 * The corpus half deliberately avoids operator metrics. Queue depth, rate-limit headroom and
 * shard coverage belong in Settings; what belongs here is *how much is here, how good is it,
 * and how much can I actually use* — which is why licence mix gets equal billing with the
 * skill count. A result you cannot download is a different thing from one you can.
 */
export default async function DashboardPage() {
  // Re-checked here, not inherited from the layout: every page resolves the session itself.
  // It is cached per request, so this costs nothing.
  const session = await requireSession();
  const firstName = session.user.name.split(/\s+/)[0] || session.user.email;

  const [stats, owned] = await Promise.all([platformStats(), mySkills()]);

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Dashboard</h1>
        <p className="text-muted-foreground">
          Welcome back, {firstName}.
        </p>
      </div>

      {/* ---- The corpus at a glance ---------------------------------------- */}
      <section className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Stat
            label="Skills indexed"
            value={stats.indexed}
            detail={`from ${stats.sources} sources`}
          />
          <Stat
            label="Passed validation"
            value={`${stats.passRate}%`}
            detail={`${stats.quarantined.toLocaleString()} quarantined`}
          />
          <Stat
            label="Downloadable"
            value={stats.downloadable}
            detail="licence permits redistribution"
          />
          <Stat
            label="Last sync"
            value={
              stats.hoursSinceSync === null
                ? "—"
                : stats.hoursSinceSync < 1
                  ? "just now"
                  : `${stats.hoursSinceSync}h ago`
            }
            detail={`${stats.sourcesSynced} of ${stats.sources} sources synced`}
          />
          {/*
            The one figure here that is not a fact about the corpus.

            The four above count what came in; this counts what has been learned from it.
            Measured in **distinct structures** rather than skills because that is the unit
            the mine uses — a skill count would inflate the evidence by exactly the factor
            the miner exists to divide out.
          */}
          <Stat
            label="Archetypes"
            value={`${stats.archetypeCategories} of ${stats.functionCategories}`}
            detail={`from ${stats.archetypeStructures.toLocaleString()} distinct structures`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Quality</CardTitle>
              <CardDescription>
                Composite score per skill — structure, documentation and resource hygiene.
                Bands rather than an average, because an average over thousands of skills
                moves by a point a week and tells you nothing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Distribution
                rows={stats.qualityBands.map((row) => ({
                  label: row.band,
                  count: row.count,
                }))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Licences</CardTitle>
              <CardDescription>
                What each licence lets you do with the skill. The two &ldquo;Mirrored&rdquo;
                postures can be downloaded &mdash; the rest are indexed with a link to
                origin, because their licence does not permit us to redistribute the
                content.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2">
                {stats.licenceMix.map((row) => (
                  <li
                    key={row.posture}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <LicenseBadge spdx={null} redistribution={row.posture} />
                    <span className="text-muted-foreground tabular-nums">
                      {row.count.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        {stats.variants > 0 || stats.tombstoned > 0 ? (
          <p className="text-muted-foreground text-xs">
            {stats.variants.toLocaleString()} near-duplicates are folded under a canonical
            entry and stay reachable from it
            {stats.tombstoned > 0
              ? `; ${stats.tombstoned.toLocaleString()} withdrawn upstream, metadata retained`
              : ""}
            .
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/skills">
              Browse the registry
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          {/* The route out of the number above. A count with no way to read one is the
              state the archetype pages were built to end. */}
          <Button asChild variant="outline" size="sm">
            <Link href="/archetypes">
              Read the archetypes
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      {/* ---- What's mine ---------------------------------------------------- */}
      <section className="grid gap-3">
        <h2 className="text-base font-semibold tracking-tight">Your skills</h2>
        {owned.length > 0 ? (
          <ul className="grid gap-2">
            {owned.map((skill) => (
              <li key={skill.id}>
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    <Link href={`/skills/${skill.slug}`} className="min-w-0 flex-1">
                      <span className="font-medium">{skill.name}</span>
                      {skill.summary ? (
                        <span className="text-muted-foreground line-clamp-1 block text-sm">
                          {skill.summary}
                        </span>
                      ) : null}
                    </Link>
                    <Badge variant="outline">{skill.status}</Badge>
                    {skill.qualityScore !== null ? (
                      <Badge variant="secondary">{skill.qualityScore}/100</Badge>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <BuilderPlaceholder />
        )}
      </section>
    </div>
  );
}

/**
 * The empty state, written as a plan rather than a teaser.
 *
 * Nothing writes an org-scoped skill yet, so this is what every user sees. An empty panel
 * saying "no skills" would be true and useless; saying what will go here, and pointing at
 * the two things that already work, is the honest version.
 */
function BuilderPlaceholder() {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="text-muted-foreground size-4" />
          Nothing here yet
        </CardTitle>
        <CardDescription>
          Skills you create will land here. The builder is not built yet — when it is, it
          will scaffold a skill from what the corpus shows actually works in its category,
          merge in your own workflow and constraints, and run the full validation pipeline
          before you publish.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-muted-foreground text-sm">In the meantime:</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/skills">
              <PackageSearch className="size-4" />
              Browse the registry
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/skills?sort=quality">
              <Download className="size-4" />
              Download a high-quality skill
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="grid gap-1">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
        {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}

function Distribution({ rows }: { rows: Array<{ label: string; count: number }> }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return <p className="text-muted-foreground text-sm">Nothing scored yet.</p>;
  }

  return (
    <ul className="grid gap-2">
      {rows.map((row) => {
        const share = Math.round((row.count / total) * 100);
        return (
          <li key={row.label} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span>{row.label}</span>
              <span className="text-muted-foreground tabular-nums text-xs">
                {row.count.toLocaleString()} · {share}%
              </span>
            </div>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div className="bg-primary h-full rounded-full" style={{ width: `${share}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
