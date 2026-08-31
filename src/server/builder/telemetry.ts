import "server-only";

import { sql } from "drizzle-orm";

import { builderSignals } from "@/server/db/schema";
import { db, type Db } from "@/server/db";
import { sectionRoleLabel } from "@/lib/section-roles";

/**
 * Creation telemetry (Doc 2 R6.2), bounded against poisoning (R6.5).
 *
 * The return arrow. Archetype mining reads the corpus — what people published elsewhere —
 * and until now had no way to know what happened when somebody actually *used* a skeleton.
 * This records that, and `mineArchetype` consumes it alongside prevalence.
 *
 * ## What a signal is, and what it can never be
 *
 * One row per (draft, section role) at publish: was the section offered, did the author
 * write notes for it, did it survive into the published document, and did that document
 * pass validation first time (G3). Booleans, a category and a role from our own closed
 * vocabulary — nothing else may ever be added. See the schema comment for why that is what
 * makes R6.2 compatible with RC.5.
 *
 * ## R6.5 is four separate mechanisms, not a flag
 *
 * The requirement names three defences and implies a fourth, and they defend against
 * different attacks. Implementing one and calling it done would leave the others open:
 *
 *  1. **Deduplicated per identity** — a unique index on `(draft_id, section_role)`. One
 *     authoring session is one opinion per section, however often it is republished.
 *  2. **Rate-limited** — `MAX_DRAFTS_PER_ORG` caps how many of an organisation's drafts
 *     count toward any one category. Without it, dedup is defeated by making more drafts.
 *  3. **Outlier-trimmed** — organisations at the extremes of survival rate are dropped
 *     before averaging, so a determined minority cannot drag the mean.
 *  4. **Bounded delta** — whatever survives all of that may move a section's lift by at
 *     most `MAX_LIFT_DELTA` points per mine. This is the backstop: even a perfectly
 *     executed attack that beats the first three moves the archetype by a few points.
 *
 * `MIN_DISTINCT_ORGS` sits underneath all four. Below it nothing is applied at all, which
 * serves R6.5 *and* the privacy floor — an aggregate over one or two organisations could
 * describe a single tenant.
 */

/** Below this many distinct organisations, a category's telemetry is not used at all. */
export const MIN_DISTINCT_ORGS = 3;

/** Drafts from one organisation that may count toward one category. R6.5's rate limit. */
export const MAX_DRAFTS_PER_ORG = 5;

/** Organisations trimmed from each end of the survival distribution before averaging. */
export const TRIM_PER_TAIL = 1;

/**
 * The most telemetry may move a section's lift, in points, per mine.
 *
 * Small on purpose. Corpus prevalence is measured over thousands of documents; authoring
 * signal is measured over tens, and it is the half an attacker can actually generate. Five
 * points can promote or demote a borderline section over several cycles and can never, in
 * one cycle, invent or erase one.
 */
export const MAX_LIFT_DELTA = 5;

/** Minimum drafts touching a section before its rate means anything. */
const MIN_DRAFTS_PER_SECTION = 5;

export type SectionSignal = {
  role: string;
  offered: boolean;
  authored: boolean;
  survived: boolean;
};

/**
 * Records one draft's outcome. Called from the publish path, inside its org scope.
 *
 * Takes the transaction rather than opening its own: the signals belong to the same commit
 * as the skill they describe, so a publish that rolls back cannot leave telemetry claiming
 * a skill exists.
 */
export async function recordSignals(
  tx: Db,
  input: {
    orgId: string;
    draftId: string;
    skillId: string;
    category: string;
    archetypeVersion: number | null;
    firstPassValid: boolean;
    sections: SectionSignal[];
  },
): Promise<number> {
  if (input.sections.length === 0) return 0;

  await tx
    .insert(builderSignals)
    .values(
      input.sections.map((section) => ({
        orgId: input.orgId,
        draftId: input.draftId,
        skillId: input.skillId,
        archetypeCategory: input.category,
        archetypeVersion: input.archetypeVersion,
        sectionRole: section.role,
        offered: section.offered,
        authored: section.authored,
        survived: section.survived,
        firstPassValid: input.firstPassValid,
      })),
    )
    // Republishing must not double-count. The unique index is the guarantee; this is how
    // the second attempt declines gracefully instead of throwing.
    .onConflictDoNothing();

  return input.sections.length;
}

export type SectionTelemetry = {
  role: string;
  /** Distinct drafts that counted, after the per-org rate limit. */
  drafts: number;
  /** Distinct organisations behind them. */
  orgs: number;
  /** Share of offering drafts where the section survived, 0–100, trimmed. */
  survivalRate: number;
  /** Share of surviving cases whose skill passed validation first time, 0–100. */
  firstPassRate: number;
  /** Bounded adjustment this contributes to the section's lift. */
  delta: number;
};

export type CategoryTelemetry = {
  category: string;
  /** Total distinct drafts observed, before per-section thresholds. */
  drafts: number;
  orgs: number;
  /** Empty when the category is below `MIN_DISTINCT_ORGS`. */
  sections: SectionTelemetry[];
  /** Why nothing was applied, when nothing was. */
  withheldReason: string | null;
};

/**
 * Aggregates a category's signals with every R6.5 bound applied.
 *
 * Reads unscoped on purpose — cross-organisation aggregation is the entire point, and the
 * table's read policy allows it precisely because the columns cannot carry tenant content.
 */
export async function categoryTelemetry(category: string): Promise<CategoryTelemetry> {
  /**
   * The rate limit is applied in SQL, before anything is counted.
   *
   * `row_number()` per organisation over its drafts, keeping the oldest
   * `MAX_DRAFTS_PER_ORG`. Doing it here rather than after aggregation matters: an
   * organisation that produced two hundred drafts must not contribute two hundred votes and
   * then be trimmed as a single outlier — it would have already moved the mean.
   */
  const rows = await db.execute(sql`
    with ranked as (
      select
        org_id, draft_id, section_role, offered, survived, first_pass_valid,
        dense_rank() over (partition by org_id order by draft_id) as org_draft_rank
      from builder_signals
      where archetype_category = ${category}
    ),
    capped as (
      select * from ranked where org_draft_rank <= ${MAX_DRAFTS_PER_ORG}
    ),
    per_org as (
      select
        section_role,
        org_id,
        count(*) filter (where offered)::int as offered,
        count(*) filter (where offered and survived)::int as survived,
        count(*) filter (where survived and first_pass_valid)::int as first_pass
      from capped
      group by section_role, org_id
    )
    select
      section_role,
      org_id,
      offered,
      survived,
      first_pass,
      (select count(distinct draft_id) from capped)::int as total_drafts,
      (select count(distinct org_id) from capped)::int as total_orgs
    from per_org
    where offered > 0
  `);

  type Row = {
    section_role: string;
    org_id: string;
    offered: number;
    survived: number;
    first_pass: number;
    total_drafts: number;
    total_orgs: number;
  };
  const data = rows.rows as unknown as Row[];

  const drafts = data[0]?.total_drafts ?? 0;
  const orgs = data[0]?.total_orgs ?? 0;

  if (orgs < MIN_DISTINCT_ORGS) {
    return {
      category,
      drafts,
      orgs,
      sections: [],
      withheldReason: `${orgs} of ${MIN_DISTINCT_ORGS} organisations — too few to aggregate`,
    };
  }

  const byRole = new Map<string, Row[]>();
  for (const row of data) {
    const list = byRole.get(row.section_role) ?? [];
    list.push(row);
    byRole.set(row.section_role, list);
  }

  const sections: SectionTelemetry[] = [];
  for (const [role, orgRows] of byRole) {
    const totalOffered = orgRows.reduce((sum, r) => sum + r.offered, 0);
    if (totalOffered < MIN_DRAFTS_PER_SECTION || orgRows.length < MIN_DISTINCT_ORGS) continue;

    /**
     * Trim before averaging, per organisation rather than per draft.
     *
     * The unit of manipulation is an account, not a document, so the extremes that get
     * dropped have to be accounts. Trimming drafts would let one organisation supply both
     * tails and keep its own middle.
     */
    const rates = orgRows
      .map((r) => ({ org: r.org_id, rate: r.survived / r.offered }))
      .sort((a, b) => a.rate - b.rate);
    const trimmed =
      rates.length > TRIM_PER_TAIL * 2 + 1
        ? rates.slice(TRIM_PER_TAIL, rates.length - TRIM_PER_TAIL)
        : rates;

    const survivalRate = Math.round(
      (trimmed.reduce((sum, r) => sum + r.rate, 0) / trimmed.length) * 100,
    );
    const survived = orgRows.reduce((sum, r) => sum + r.survived, 0);
    const firstPass = orgRows.reduce((sum, r) => sum + r.first_pass, 0);

    /**
     * Survival above half nudges the section up, below half nudges it down.
     *
     * Centred on 50 rather than on the corpus prevalence because the two measure different
     * things — prevalence is what other people wrote, survival is what happened when this
     * skeleton was used — and folding one into the other would make neither readable. The
     * result is clamped, so no amount of signal exceeds `MAX_LIFT_DELTA`.
     */
    const delta = Math.max(
      -MAX_LIFT_DELTA,
      Math.min(MAX_LIFT_DELTA, Math.round(((survivalRate - 50) / 50) * MAX_LIFT_DELTA)),
    );

    sections.push({
      role,
      drafts: totalOffered,
      orgs: orgRows.length,
      survivalRate,
      firstPassRate: survived > 0 ? Math.round((firstPass / survived) * 100) : 0,
      delta,
    });
  }

  sections.sort((a, b) => b.drafts - a.drafts);
  return { category, drafts, orgs, sections, withheldReason: null };
}

/**
 * One line for the archetype changelog, which R6.2's acceptance criterion requires.
 *
 * "acceptance/rejection statistics are inputs **and the archetype changelog cites them**" —
 * so a mine that used telemetry has to say so, in the row, where anyone reading the
 * archetype's history can see which sections moved and by how much.
 */
export function describeTelemetry(telemetry: CategoryTelemetry): string | null {
  const moved = telemetry.sections.filter((s) => s.delta !== 0);
  if (moved.length === 0) return null;

  const parts = moved
    .slice(0, 4)
    .map(
      (s) =>
        `${sectionRoleLabel(s.role)} ${s.delta > 0 ? "+" : ""}${s.delta} (${s.survivalRate}% kept)`,
    );

  return `authoring signal from ${telemetry.drafts} draft(s) across ${telemetry.orgs} workspaces: ${parts.join(", ")}`;
}
