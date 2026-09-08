import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FlagsPanel } from "@/components/settings/flags-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { flagQueue } from "@/server/curation/flags";
import {
  endorsementsBy,
  liveMaintainerships,
  scopeOf,
} from "@/server/curation/maintainers";
import { isAdmin } from "@/server/dal/admin";
import { requireSession } from "@/server/dal/session";
import { labelFor, type CategoryAxis } from "@/server/taxonomy/vocabulary";

export const metadata: Metadata = { title: "Curation" };

/**
 * The maintainer's own desk (Doc 6 RK.6, plan step E5).
 *
 * ## Why this is not a tab in `/settings`
 *
 * `/settings` is admin-only three times over — the sidebar hides it, the page `notFound()`s, and
 * every action re-checks. Widening any of those to let maintainers through would weaken the one
 * guarantee that page makes, in order to show them one card out of seventeen. A maintainer is not
 * a junior admin: they have authority over their own categories and none at all over the
 * platform, and two pages state that plainly where one page with hidden tabs would not.
 *
 * ## What a maintainer sees is bounded by what they may decide
 *
 * The queue is filtered by the categories they hold — not sorted by them, filtered. A report they
 * cannot act on is not a to-do list, it is somebody else's work rendered as though it were
 * theirs. An admin sees everything, because they may decide everything; that is the same query
 * with `scope = null`, so the two views cannot drift.
 */
export default async function CuratePage() {
  const session = await requireSession();
  const [admin, held] = await Promise.all([
    isAdmin(),
    liveMaintainerships(session.user.id),
  ]);

  /*
   * Neither a maintainer nor an admin: this route does not exist for them.
   *
   * `notFound()` rather than a redirect or an explanation, for the same reason `/settings` does
   * it — somebody with no standing has no reason to learn that a curation desk is here, and a
   * "you are not allowed" page is an invitation to find out who is.
   */
  if (!admin && held.length === 0) notFound();

  const [queue, mine, scope] = await Promise.all([
    /* `null` is the admin's whole-queue case; an array is a bounded one. Never an empty array. */
    flagQueue("received", admin ? null : held.map((h) => ({ axis: h.axis, category: h.category }))),
    endorsementsBy(session.user.id),
    held.length > 0 ? scopeOf(session.user.id) : Promise.resolve({ held, skills: 0 }),
  ]);

  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Curation</h1>
        <p className="text-muted-foreground text-sm">
          Reader reports on the categories you maintain, and the skills you have put your name
          to.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your categories</CardTitle>
          <CardDescription>
            {admin && held.length === 0
              ? "You are a system admin, so you see every report. You maintain no category, so you cannot endorse anything — those are separate authorities on purpose."
              : `${scope.skills.toLocaleString()} servable skills sit in the categories you maintain. You may decide reports on those, and endorse them.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {held.length === 0 ? (
            <p className="text-muted-foreground text-sm">No maintainer standing.</p>
          ) : (
            held.map((h) => (
              <Badge key={`${h.axis}:${h.category}`} variant="outline">
                {labelFor(h.axis as CategoryAxis, h.category)}
                <span className="text-muted-foreground ml-1.5 text-[10px]">{h.axis}</span>
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      {/*
        The same component the settings tab renders, fed a different query.

        One panel, one action, one set of rules about what upholding means — a second, "lighter"
        curator view is how two definitions of the same decision come to exist, which is the
        argument R6.1 makes for publish-back calling the real validator.
      */}
      <FlagsPanel
        rows={queue.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          skillStatus: row.skillStatus,
          reason: row.reason,
          note: row.note,
          contact: row.contact,
          createdAt: row.createdAt.toISOString(),
          stale: row.stale,
        }))}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your endorsements</CardTitle>
          <CardDescription>
            {mine.length === 0
              ? "You have endorsed nothing yet. Endorsing is done from a skill's own page."
              : "Each one carries your name and the category you spoke as. Withdraw from the skill's page."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {mine.map((row) => (
            <div key={row.slug} className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm">
              <Link href={`/skills/${row.slug}`} className="truncate underline underline-offset-4">
                {row.name}
              </Link>
              <Badge variant="outline" className="text-[10px]">
                as {labelFor(row.axis as CategoryAxis, row.category)}
              </Badge>
              {/*
                Stale is shown to the endorser first, because they are the only person who can
                do anything about it: re-read the new version and endorse again, or withdraw.
              */}
              {row.stale ? (
                <Badge variant="outline" className="text-amber-600 text-[10px] dark:text-amber-400">
                  a newer version has replaced the one you read
                </Badge>
              ) : null}
              <span className="text-muted-foreground text-xs">
                {row.at.toISOString().slice(0, 10)}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
