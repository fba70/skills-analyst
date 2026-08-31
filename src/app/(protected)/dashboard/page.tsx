import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { LicenseBadge } from "@/components/registry/license-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/server/dal/session";
import { listDrafts } from "@/server/builder/drafts";
import { platformStats } from "@/server/dal/stats";

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

  // Drafts, not `mySkills()`. Nothing writes an org-scoped row into `skills` — a draft
  // becomes one only when it is published — so reading the corpus table here would show an
  // empty list to someone who has just written three skills.
  const [stats, drafts] = await Promise.all([platformStats(), listDrafts()]);

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

        {/*
          Two cards read as one panel, so their rows have to sit on the same lines.

          Two things were pushing them apart. The headers are free text of different
          lengths, so one description wrapping to an extra line moved everything under it;
          `grid-rows-subgrid` puts both headers in a shared row and both bodies in another,
          which sizes them together instead of independently. And the licence rows had no
          share bar, so they were shorter than the quality rows and drifted further out of
          line with each one. Both lists now render through `Distribution`, so a row is a
          row whatever is in its label.
        */}
        <div className="grid gap-4 lg:grid-cols-2 lg:grid-rows-[auto_1fr]">
          <Card className="lg:row-span-2 lg:grid lg:grid-rows-subgrid">
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
                  key: row.band,
                  label: row.band,
                  count: row.count,
                }))}
              />
            </CardContent>
          </Card>

          <Card className="lg:row-span-2 lg:grid lg:grid-rows-subgrid">
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
              <Distribution
                rows={stats.licenceMix.map((row) => ({
                  key: row.posture,
                  label: <LicenseBadge spdx={null} redistribution={row.posture} />,
                  count: row.count,
                }))}
              />
            </CardContent>
          </Card>
        </div>

      </section>

      {/* ---- What's mine ---------------------------------------------------- */}
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold tracking-tight">Your skills</h2>
          <Button asChild size="sm" className="ml-auto">
            <Link href="/build">
              <Sparkles className="size-4" />
              Build your skill
            </Link>
          </Button>
        </div>
        {drafts.length > 0 ? (
          <ul className="grid gap-2">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    <Link href={`/build/${draft.id}`} className="min-w-0 flex-1">
                      <span className="font-medium">{draft.name}</span>
                      {draft.summary ? (
                        <span className="text-muted-foreground line-clamp-1 block text-sm">
                          {draft.summary}
                        </span>
                      ) : null}
                    </Link>
                    <Badge variant="outline">{draft.status}</Badge>
                    {draft.qualityScore !== null ? (
                      <Badge variant="secondary">{draft.qualityScore}/100</Badge>
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
          Skills you write will land here. The builder scaffolds from what the corpus shows
          actually works in a category, merges in your own workflow and constraints, and
          runs the validation analyzers before you see the draft.
        </CardDescription>
      </CardHeader>
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

/**
 * One distribution, used by both cards so their rows land on the same lines.
 *
 * `min-h-6` on the label line is what makes that hold across different label content: a
 * `LicenseBadge` is taller than a bare word, so without a floor the licence rows would each
 * be a pixel or two off and the drift would accumulate down the list. Six is the badge's own
 * height, so nothing is padded — the text row is simply told to match it.
 *
 * `items-center` rather than `items-baseline` for the same reason. A badge has no useful
 * baseline to share with the number beside it; centring is what makes a chip and a figure
 * look level.
 */
function Distribution({
  rows,
}: {
  rows: Array<{ key: string; label: React.ReactNode; count: number }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) {
    return <p className="text-muted-foreground text-sm">Nothing scored yet.</p>;
  }

  return (
    <ul className="grid gap-3">
      {rows.map((row) => {
        const share = Math.round((row.count / total) * 100);
        // A row with skills in it must not read as 0%, and must not draw an empty track:
        // "43 · 0%" beside a blank bar looks like a bug rather than like a small number.
        const rounded = share === 0 && row.count > 0 ? "<1%" : `${share}%`;

        return (
          <li key={row.key} className="grid gap-1.5">
            <div className="flex min-h-6 items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {row.count.toLocaleString()} · {rounded}
              </span>
            </div>
            <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
              <div
                className="bg-primary h-full rounded-full"
                style={{ width: `${row.count > 0 ? Math.max(share, 1) : 0}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
