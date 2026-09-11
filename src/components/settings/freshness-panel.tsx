"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useTransition } from "react";
import { CalendarClock, History, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { setReviewDateAction } from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DUE_SOON_DAYS, ROT_THRESHOLD, reviewUrgency } from "@/lib/freshness";
import { DRIFT_STEPS_BEFORE_SURFACING, versionedLabel } from "@/lib/versions";
import type { VersionSummaryView } from "@/server/skills/drift-read";

/**
 * Freshness (Doc 6 RK.2, plan step E1).
 *
 * ## The half that was missing
 *
 * A4 shipped `review_by` and a derived `stale` state with no web entry point at all, and the note
 * it left said why the panel waited: *one that can set a review date but cannot yet tell anyone it
 * has passed is furniture.* So this leads with what is overdue, and setting a date is the thing
 * you do about it rather than the thing the panel is for.
 *
 * ## Undated is not neglected
 *
 * Most of the corpus has no review date and that is correct — a date is a governance decision
 * somebody made, and its absence means nobody has made one. A panel that listed every undated
 * skill as outstanding would be listing 49,000 rows and would be ignored by lunchtime.
 *
 * ## Only confidently dead links appear
 *
 * A 403 is a site refusing *us*; a timeout is a network. Neither says the page is gone, and both
 * would fill this list with things nobody can fix. Only repeated 404s and 410s are shown, and the
 * counts of the other two are given underneath so the reader knows what is being withheld and
 * why.
 *
 * ## Version drift is the third kind, and it is the one that changes nothing
 *
 * A review date passing makes a skill `stale`; a dead link is a fault. A newer release of Node
 * is neither — a skill teaching one version's idioms is right for a codebase on that version.
 * So the drift section reports and never demotes, and says so where somebody might assume
 * otherwise.
 */

export type DueRow = {
  id: string;
  slug: string;
  name: string;
  reviewBy: string | null;
};

/*
 * The row shape comes from the reader boundary rather than being restated here.
 *
 * `import type` is erased at compile time, so a `server-only` module is never pulled into the
 * client bundle — and it means the panel and `versionSummaryView` cannot drift into disagreeing
 * about a field. `DueRow` and `RottenRow` above predate that and still declare their own.
 */
export type VersionsView = VersionSummaryView;

export type RottenRow = {
  slug: string;
  name: string;
  url: string;
  statusCode: number | null;
  failures: number;
  firstFailedAt: string | null;
};

export function FreshnessPanel({
  due,
  rotten,
  coverage,
  versions,
}: {
  due: DueRow[];
  rotten: RottenRow[];
  /** `null` when `tool_versions` is absent — the section prints the command, not a table. */
  versions: VersionsView;
  coverage: {
    versionsChecked: number;
    servable: number;
    links: number;
    blocked: number;
    unreachable: number;
  };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dates, setDates] = useState<Record<string, string>>({});

  function save(skillId: string, slug: string) {
    const value = dates[skillId] ?? "";
    startTransition(async () => {
      const result = await setReviewDateAction(skillId, value || null);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(value ? `${slug} is due again on ${value}.` : `Review date cleared on ${slug}.`);
      router.refresh();
    });
  }

  const checkedPercent =
    coverage.servable > 0 ? Math.round((coverage.versionsChecked / coverage.servable) * 100) : 0;

  return (
    <div className="grid min-w-0 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <CalendarClock className="size-4" />
            Due for review
            {due.length > 0 ? (
              <span className="text-muted-foreground text-xs font-normal">{due.length}</span>
            ) : null}
          </CardTitle>
          <CardDescription>
            Skills whose review date has passed or falls within {DUE_SOON_DAYS} days. An overdue
            skill is shown as <em>stale</em> to readers automatically — this is where that gets
            resolved, by looking at it and setting a new date.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-2">
          {due.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing due. Skills with no review date at all are not listed: a date is a decision
              somebody made, and not having made one is not a backlog.
            </p>
          ) : (
            due.map((row) => {
              const urgency = reviewUrgency(row.reviewBy ? new Date(row.reviewBy) : null);
              return (
                <div key={row.id} className="grid min-w-0 gap-2 rounded-md border p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link
                      href={`/skills/${row.slug}`}
                      className="min-w-0 truncate text-sm font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <Badge
                      variant={urgency === "overdue" ? "outline" : "secondary"}
                      className={urgency === "overdue" ? "border-destructive/50" : undefined}
                    >
                      {urgency === "overdue" ? "overdue" : "due soon"}
                    </Badge>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {row.reviewBy?.slice(0, 10)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="date"
                      className="h-8 w-40"
                      value={dates[row.id] ?? ""}
                      onChange={(e) => setDates((d) => ({ ...d, [row.id]: e.target.value }))}
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={isPending}
                      onClick={() => save(row.id, row.slug)}
                    >
                      {isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                      Set
                    </Button>
                    {/*
                      Clearing is a real decision, not a cancel. It says "this no longer needs
                      reviewing on a clock", which removes the skill's route to `stale` entirely —
                      so it gets its own control rather than being an empty save.
                    */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      disabled={isPending}
                      onClick={() => {
                        setDates((d) => ({ ...d, [row.id]: "" }));
                        save(row.id, row.slug);
                      }}
                    >
                      No longer on a clock
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Link2Off className="size-4" />
            Dead links
            {rotten.length > 0 ? (
              <span className="text-muted-foreground text-xs font-normal">{rotten.length}</span>
            ) : null}
          </CardTitle>
          <CardDescription>
            The one kind of decay nobody has to declare. A skill pointing at documentation that
            has gone still passes every analyzer — and sends an agent nowhere.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-2">
          {/*
            Coverage first. "4 dead links" over a corpus 3% checked invites the reader to conclude
            the corpus is healthy — the same misreading `archetypes --blocks` produced at 1%.
          */}
          <p className="text-muted-foreground text-xs">
            {coverage.versionsChecked} of {coverage.servable} servable skills checked (
            {checkedPercent}%), {coverage.links} links known.
            {checkedPercent < 50
              ? " These counts describe that slice, not the corpus — run pnpm links --check 200."
              : ""}
          </p>

          {rotten.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing confidently dead.</p>
          ) : (
            <ul className="grid gap-2">
              {rotten.map((row) => (
                <li key={`${row.slug}-${row.url}`} className="grid min-w-0 gap-0.5 rounded-md border p-3">
                  <Link
                    href={`/skills/${row.slug}`}
                    className="min-w-0 truncate text-sm font-medium hover:underline"
                  >
                    {row.name}
                  </Link>
                  <code className="text-muted-foreground min-w-0 truncate text-xs">{row.url}</code>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {row.statusCode ?? "no response"} · {row.failures} consecutive checks
                    {row.firstFailedAt ? ` · since ${row.firstFailedAt.slice(0, 10)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            What is being withheld, and why. Without this the panel looks like it found four
            problems; with it, the reader knows it found four it is sure about and set aside a
            larger number it cannot conclude anything from.
          */}
          <p className="text-muted-foreground border-t pt-3 text-xs">
            Reported after {ROT_THRESHOLD} consecutive 404s or 410s. Not shown: {coverage.blocked}{" "}
            link{coverage.blocked === 1 ? "" : "s"} where the server refused us (401/403/429) and{" "}
            {coverage.unreachable} that timed out or failed to connect — neither says the page is
            gone, and listing them would be asking somebody to fix our own user agent.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <History className="size-4" />
            Tracked releases
            {versions && versions.checked > 0 ? (
              <span className="text-muted-foreground text-xs font-normal">
                {versions.checked} of {versions.tracked}
              </span>
            ) : null}
          </CardTitle>
          <CardDescription>
            What each tracked project has released, so a skill naming an older version can say
            so. <strong>This changes nothing</strong> — no lifecycle state, no score, no ranking.
            A skill written for one version is right for a codebase on that version, and a skill
            is only shown as drifting at {DRIFT_STEPS_BEFORE_SURFACING} or more releases
            behind.
          </CardDescription>
        </CardHeader>

        <CardContent className="grid gap-3">
          {versions === null ? (
            <p className="text-muted-foreground text-sm">
              Release tracking is not set up yet — apply the migration, then run{" "}
              <code className="font-mono text-xs">pnpm versions --check</code>.
            </p>
          ) : (
            <>
              {/*
                Coverage before the table, the same discipline the dead-link count takes. The
                second sentence is the one that matters: the pin detector is a regex over prose
                and finds far more names than this list recognises, so the gap between these two
                numbers is expected rather than a shortfall.
              */}
              <p className="text-muted-foreground text-xs">
                {versions.documentsWithPins.toLocaleString()} document
                {versions.documentsWithPins === 1 ? "" : "s"} pin a version of something. Only the{" "}
                {versions.tracked} projects below are compared — everything else the detector
                found is a name nothing tracks, and is left alone rather than guessed at.
              </p>

              {versions.checked === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing checked yet. Run{" "}
                  <code className="font-mono text-xs">pnpm versions --check</code>.
                </p>
              ) : (
                <ul className="grid gap-1.5">
                  {versions.rows.map((row) => {
                    return (
                      <li
                        key={row.subject}
                        className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b pb-1.5 text-sm last:border-0"
                      >
                        <span className="min-w-32 font-medium">{versionedLabel(row.subject)}</span>
                        <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                          {row.currentVersion ?? "—"}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {row.releasedAt ? `released ${row.releasedAt.slice(0, 10)}` : ""}
                        </span>
                        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                          checked{" "}
                          {row.checkedDaysAgo === 0 ? "today" : `${row.checkedDaysAgo}d ago`}
                        </span>
                        {row.status !== "ok" ? (
                          /*
                            `blocked` is a fact about our request and `unreachable` about the
                            network — neither is a fact about the project, and neither clears
                            the version already known. Named rather than hidden so a stale
                            figure is explicable.
                          */
                          <Badge variant="outline" className="border-amber-600/40">
                            {row.status}
                            {row.consecutiveFailures > 1 ? ` ×${row.consecutiveFailures}` : ""}
                          </Badge>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
