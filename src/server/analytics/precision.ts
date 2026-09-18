import "server-only";

import { sql } from "drizzle-orm";

import { MIN_REVIEWED_FOR_PRECISION, QUARANTINE_PRECISION_TARGET } from "@/lib/gates";
import { withPublicScope } from "@/server/dal/scope";

/**
 * Quarantine precision — Doc 3's stage gate, measured rather than quoted.
 *
 * Three files said *"quarantine precision is a tracked metric (≥90% on spot-check)"* — two
 * analyzers and the queue panel — and **nothing computed it**. A gate that lives only in
 * prose is a gate nobody can fail, and this one is load-bearing: Doc 3 makes it the
 * condition for opening the registry to the public, on the argument that a pipeline which
 * quarantines noisily erodes trust faster than one that misses things.
 *
 * ## Why it could not be computed before, and what changed
 *
 * The schema recorded only the **disagreements**. `releaseFromQuarantine` writes a
 * `curator-override` verdict; agreeing with the analyzer wrote nothing at all. So *reviewed
 * and correct* and *nobody has opened it* were the same silence, and the only expressible
 * number was
 *
 *     1 − released ÷ ever-quarantined
 *
 * which is a **lower bound wearing a precision's clothes**, and it reads highest exactly
 * when nobody is checking: a queue nobody has touched scores 100%. `confirmQuarantine` adds
 * the other row, so precision is now measured over what a curator actually looked at.
 *
 * ## What this returns, and what it refuses to
 *
 * - **The denominator is the reviewed set**, never the queue. 1,053 quarantined versions
 *   cannot be spot-checked by hand, so a gate denominated in the whole queue could never be
 *   cleared by any amount of work — the alarm-nobody-can-silence shape that `db:audit` and
 *   the marker threshold both had to be rescued from.
 * - **Coverage travels with the number.** *94% over 31 of 1,053* and *94% over 31 of 31* are
 *   the same percentage and different claims, and only the second is a census.
 * - **Below `MIN_REVIEWED_FOR_PRECISION` the figure is `null`**, not a small percentage.
 *   The caller renders *not measured yet* rather than a number somebody will quote.
 * - It says **which zero it is**: nothing quarantined at all, and nothing reviewed yet, are
 *   opposite facts that both produce an empty result.
 *
 * ## Public corpus only
 *
 * `withPublicScope` and nothing else. The gate is about the pipeline that fills the public
 * registry; folding a workspace's own quarantines into it would mean one tenant's authoring
 * could move a number Doc 3 reads as a platform property (RC.5, again, through a new door).
 */

export type QuarantinePrecision = {
  /** Versions sitting in quarantine right now. */
  quarantined: number;
  /** Versions that have *ever* been quarantined, from the audit log. The honest denominator for coverage. */
  everQuarantined: number;
  /** Versions a curator has decided about, either way. The denominator for precision. */
  reviewed: number;
  /** Reviewed and left in quarantine — the analyzer was right. */
  upheld: number;
  /** Reviewed and released — the analyzer was wrong, by our own subsequent judgement. */
  released: number;
  /** `upheld / reviewed`, 0–100, or null below `MIN_REVIEWED_FOR_PRECISION`. */
  precision: number | null;
  /** `reviewed / everQuarantined`, 0–100, or null when nothing has ever been quarantined. */
  coverage: number | null;
  /** The Doc 3 target, carried so a caller cannot restate it differently. */
  target: number;
  /** Null while `precision` is null: an unmeasured gate is neither met nor missed. */
  meets: boolean | null;
  /** Why the figure is absent, when it is. Rendered verbatim — the two zeros differ. */
  absentReason: string | null;
};

export async function quarantinePrecision(): Promise<QuarantinePrecision> {
  const [row] = await withPublicScope((tx) =>
    tx.execute(sql`
      with reviewed as (
        /**
         * One row per version a curator decided about, and which way.
         *
         * A version can carry both rows — confirmed first, released later when an analyzer
         * improved or an appeal succeeded — and in that case the release is the final word,
         * so it is counted as a false positive. Taking the max of a boolean does that
         * without a second pass.
         */
        select
          v.skill_version_id                                              as version_id,
          bool_or(v.analyzer = 'curator-override')                        as released
        from verdicts v
        join skill_versions sv on sv.id = v.skill_version_id
        where v.analyzer in ('curator-override', 'curator-review')
          and sv.org_id is null
        group by v.skill_version_id
      )
      select
        (
          select count(*)::int from skill_versions
          where status = 'quarantined' and org_id is null
        )                                                                 as quarantined,
        (
          /**
           * Ever quarantined, from the audit log rather than from the current status.
           *
           * A released version no longer has that status, so counting the status column
           * would shrink the denominator by exactly the false positives — flattering the
           * number in proportion to how wrong the pipeline was.
           */
          select count(distinct e.subject_id)::int from events e
          where e.kind = 'skill_version.quarantined' and e.org_id is null
        )                                                                 as ever_quarantined,
        (select count(*)::int from reviewed)                              as reviewed,
        (select count(*)::int from reviewed where not released)           as upheld,
        (select count(*)::int from reviewed where released)               as released
    `),
  ).then((result) => result.rows as Array<Record<string, number>>);

  const quarantined = Number(row?.quarantined ?? 0);
  const everQuarantined = Number(row?.ever_quarantined ?? 0);
  const reviewed = Number(row?.reviewed ?? 0);
  const upheld = Number(row?.upheld ?? 0);
  const released = Number(row?.released ?? 0);

  const thin = reviewed < MIN_REVIEWED_FOR_PRECISION;
  const precision = thin ? null : Math.round((upheld / reviewed) * 100);

  return {
    quarantined,
    everQuarantined,
    reviewed,
    upheld,
    released,
    precision,
    coverage: everQuarantined === 0 ? null : Math.round((reviewed / everQuarantined) * 100),
    target: QUARANTINE_PRECISION_TARGET,
    meets: precision === null ? null : precision >= QUARANTINE_PRECISION_TARGET,
    absentReason:
      everQuarantined === 0
        ? "nothing has ever been quarantined"
        : reviewed === 0
          ? "no quarantine has been spot-checked yet"
          : thin
            ? `only ${reviewed} of the ${MIN_REVIEWED_FOR_PRECISION} spot-checks a share needs`
            : null,
  };
}

/**
 * The number the schema could produce before `confirmQuarantine` existed, kept so the
 * verification can show it being wrong.
 *
 * Exported for `verify:precision` and used nowhere else, deliberately: a check that cannot
 * observe the failure it is about is not evidence, so the suite computes the naive form on
 * the same data and asserts that it reports a confident high figure over a queue nobody has
 * reviewed while {@link quarantinePrecision} withholds one.
 */
export function naivePrecision(input: { everQuarantined: number; released: number }): number {
  if (input.everQuarantined === 0) return 100;
  return Math.round((1 - input.released / input.everQuarantined) * 100);
}
