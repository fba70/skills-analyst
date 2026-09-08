"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import {
  grantMaintainerAction,
  revokeMaintainerAction,
  type ActionResult,
} from "@/app/(protected)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MAINTAINER_AXES, MAX_MAINTAINER_NOTE, type MaintainerAxis } from "@/lib/maintainers";

/**
 * Appointing and withdrawing category maintainers (Doc 6 RK.6, plan step E5).
 *
 * ## Only an admin appoints, and that is the boundary of the delegation
 *
 * A maintainer earns the right to decide reports on their own categories and to put their name
 * to a skill. They do not earn the right to appoint more maintainers. That single line is the
 * difference between delegating work and delegating the platform, and it is why this panel is
 * here — behind the admin-only page — rather than on the curation desk.
 *
 * ## The category list is the real vocabulary
 *
 * Options come from the taxonomy itself, so an appointment can never name a category that does
 * not exist. The server re-checks with `isValidCategory` anyway: a `<select>` is a hint, and the
 * action is a POST.
 */

export type MaintainerRow = {
  userId: string;
  name: string;
  axis: MaintainerAxis;
  category: string;
  categoryLabel: string;
  note: string | null;
  since: string;
  revokedAt: string | null;
};

export type MaintainersPanelProps = {
  rows: MaintainerRow[];
  /** `{ function: [...], domain: [...] }` — the live vocabulary, passed from the server. */
  options: Record<MaintainerAxis, Array<{ id: string; label: string }>>;
  summary: {
    maintainers: { live: number; revoked: number; people: number; categories: number };
    endorsements: { live: number; withdrawn: number; skills: number };
  };
  /** The categories that have nobody. Named, because that is what an admin acts on. */
  uncovered: Array<{ axis: MaintainerAxis; label: string }>;
};

export function MaintainersPanel({ rows, options, summary, uncovered }: MaintainersPanelProps) {
  const live = rows.filter((row) => !row.revokedAt);
  const lapsed = rows.filter((row) => row.revokedAt);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Maintainer groups (RK.6)</CardTitle>
          <CardDescription>
            A maintainer decides reader reports on their own categories, and may endorse skills in
            them under their own name. They cannot appoint anybody, and their standing is
            withdrawn rather than deleted — every endorsement they made stops counting the moment
            it lapses, with no sweep to run.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Figure label="People" value={summary.maintainers.people} />
          <Figure label="Categories covered" value={summary.maintainers.categories} />
          <Figure label="Live endorsements" value={summary.endorsements.live} />
          <Figure label="Skills endorsed" value={summary.endorsements.skills} />
        </CardContent>
      </Card>

      <GrantForm options={options} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Standing</CardTitle>
          <CardDescription>
            {live.length === 0
              ? "Nobody maintains anything yet. Until somebody does, every skill page correctly says that no maintainer group covers it — which is a gap in coverage, not a judgement on the corpus."
              : `${live.length} live appointment${live.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {live.map((row) => (
            <MaintainerLine key={`${row.userId}:${row.axis}:${row.category}`} row={row} />
          ))}

          {lapsed.length > 0 ? (
            <div className="mt-3 grid gap-2 border-t pt-3">
              <p className="text-muted-foreground text-xs">
                Withdrawn — kept, because the decisions they made are in the audit log and a log
                pointing at a standing that exists in no table is unreadable.
              </p>
              {lapsed.map((row) => (
                <MaintainerLine
                  key={`${row.userId}:${row.axis}:${row.category}`}
                  row={row}
                />
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Categories with nobody</CardTitle>
          <CardDescription>
            Listed rather than hidden, for the same reason `/archetypes` lists the categories
            below the evidence gate: a clean grid of covered categories would look finished and
            would tell an admin nothing about where the group is thin.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-1.5">
          {uncovered.length === 0 ? (
            <p className="text-muted-foreground text-sm">Every category has a maintainer.</p>
          ) : (
            uncovered.map((entry) => (
              <Badge
                key={`${entry.axis}:${entry.label}`}
                variant="outline"
                className="text-muted-foreground text-[10px]"
              >
                {entry.label}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

function MaintainerLine({ row }: { row: MaintainerRow }) {
  const [isPending, startTransition] = useTransition();

  function revoke() {
    startTransition(async () => {
      const outcome: ActionResult = await revokeMaintainerAction(
        row.userId,
        row.axis,
        row.category,
      );
      if (outcome.ok) toast.success("Maintainers", { description: outcome.message });
      else toast.error("Maintainers", { description: outcome.message });
    });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-2 rounded-md border p-2.5 text-sm">
      <span className="min-w-0 truncate font-medium">{row.name}</span>
      <Badge variant="outline" className="text-[10px]">
        {row.categoryLabel}
        <span className="text-muted-foreground ml-1.5">{row.axis}</span>
      </Badge>
      {row.note ? (
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{row.note}</span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="text-muted-foreground text-xs">since {row.since.slice(0, 10)}</span>
      {row.revokedAt ? (
        <Badge variant="outline" className="text-muted-foreground text-[10px]">
          withdrawn {row.revokedAt.slice(0, 10)}
        </Badge>
      ) : (
        <Button size="sm" variant="ghost" onClick={revoke} disabled={isPending}>
          Withdraw
        </Button>
      )}
    </div>
  );
}

function GrantForm({ options }: { options: MaintainersPanelProps["options"] }) {
  const [email, setEmail] = useState("");
  const [axis, setAxis] = useState<MaintainerAxis>("function");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function grant() {
    startTransition(async () => {
      const outcome = await grantMaintainerAction(email, axis, category, note);
      if (outcome.ok) {
        toast.success("Maintainers", { description: outcome.message });
        setEmail("");
        setCategory("");
        setNote("");
      } else {
        toast.error("Maintainers", { description: outcome.message });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appoint a maintainer</CardTitle>
        <CardDescription>
          By the email on their account. Re-appointing somebody whose standing lapsed restores the
          original row rather than writing a second one, so &ldquo;since when&rdquo; stays
          answerable.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            disabled={isPending}
            className="h-8 min-w-0 flex-1 text-sm"
          />
          <select
            value={axis}
            onChange={(event) => {
              setAxis(event.target.value as MaintainerAxis);
              setCategory("");
            }}
            disabled={isPending}
            className="border-input bg-background h-8 rounded-md border px-2 text-sm"
          >
            {MAINTAINER_AXES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            disabled={isPending}
            className="border-input bg-background h-8 min-w-0 rounded-md border px-2 text-sm"
          >
            <option value="">Choose a category…</option>
            {options[axis].map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_MAINTAINER_NOTE}
            placeholder="Why this person — read by the next admin reviewing the group"
            disabled={isPending}
            className="h-8 min-w-0 flex-1 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={grant}
            disabled={isPending || !email.trim() || !category}
          >
            Appoint
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
