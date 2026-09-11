import "server-only";

import type { VersionDrift } from "@/server/skills/versions";

/**
 * Reading version drift from a surface, while the table may not be there (Doc 7 RD.10, step P5).
 *
 * The same boundary `tools-read.ts` is for `skill_tools`, and for the same reason: a page must
 * not 500 because a migration has not been applied, and it must not quietly render *nothing
 * has drifted* either. Those are opposite facts — the distinction this codebase pays for most
 * often — so an absent table becomes `checked: false` and the surfaces say *not checked yet*.
 *
 * Only `42P01` is caught. Anything else is a real failure and is allowed to be one; swallowing
 * it would turn a broken query into a silent empty list, which is precisely the shape of bug a
 * reader cannot see and nobody reports.
 */

function isMissingTable(error: unknown): boolean {
  return (error as { cause?: { code?: string } })?.cause?.code === "42P01";
}

export type DriftView = {
  /** Already filtered to what is worth surfacing — `driftForVersion` applies the threshold. */
  drifts: VersionDrift[];
  /** False when nobody has read any release feed yet, which is not the same as no drift. */
  checked: boolean;
};

export async function driftViewForVersion(skillVersionId: string): Promise<DriftView> {
  try {
    const { driftForVersion } = await import("@/server/skills/versions");
    return { drifts: await driftForVersion(skillVersionId), checked: true };
  } catch (error) {
    if (isMissingTable(error)) return { drifts: [], checked: false };
    throw error;
  }
}

export type TrackedVersion = {
  subject: string;
  currentVersion: string | null;
  releasedAt: string | null;
  status: string;
  /** Days since the check ran, settled here rather than during render — see below. */
  checkedDaysAgo: number;
  consecutiveFailures: number;
};

export type VersionSummaryView = {
  tracked: number;
  checked: number;
  documentsWithPins: number;
  rows: TrackedVersion[];
} | null;

/**
 * `null` when the table is absent — the panel prints the command rather than an empty table.
 *
 * Dates are serialised and the age is **computed here**, not in the page or the panel. Two
 * reasons and both are load-bearing: `Date.now()` in a render body is impure and the linter
 * refuses it, and a clock read during render makes the server's HTML and the browser's first
 * paint disagree whenever the two differ. The heartbeat resolves its own age in its server
 * module for exactly this reason; a reader boundary is the place shaping for a surface belongs.
 */
export async function versionSummaryView(): Promise<VersionSummaryView> {
  try {
    const { versionSummary } = await import("@/server/skills/versions");
    const summary = await versionSummary();
    const now = Date.now();
    return {
      tracked: summary.tracked,
      checked: summary.checked,
      documentsWithPins: summary.documentsWithPins,
      rows: summary.rows.map((row) => ({
        subject: row.subject,
        currentVersion: row.currentVersion,
        releasedAt: row.releasedAt?.toISOString() ?? null,
        status: row.status,
        checkedDaysAgo: Math.max(0, Math.round((now - row.checkedAt.getTime()) / 86_400_000)),
        consecutiveFailures: row.consecutiveFailures,
      })),
    };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}
