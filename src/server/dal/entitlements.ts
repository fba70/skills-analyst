import "server-only";

import { eq, sql } from "drizzle-orm";

import {
  DEFAULT_PLAN,
  FREE_FOREVER,
  isFeature,
  isFreeForever,
  isPlan,
  lowestPlanFor,
  planIncludes,
  type Feature,
  type Plan,
} from "@/lib/plans";
import { db } from "@/server/db";
import { events, organization, orgEntitlements } from "@/server/db/schema";

/**
 * The entitlement gate (Doc 2 RC.1).
 *
 * In the DAL, beside `session.ts` and `admin.ts`, because RC.1 says **enforced in the
 * data-access layer, never UI-only**. A hidden button is not a gate: a server action is a
 * POST endpoint and an MCP tool is a wire protocol, so anything that decides what a customer
 * may do has to decide it here, where every path already goes.
 *
 * ## The guarantee is a refusal, not a special case
 *
 * RC.1's substance is that the trust surfaces — verdicts, provenance, quarantine status,
 * capability surface, quality score, licence posture — **cannot be paywalled by
 * configuration**. Doc 1 puts it more bluntly: paywalling the per-skill verdict would
 * destroy the platform's reason to exist.
 *
 * So `hasEntitlement` and `requireEntitlement` **throw** when handed one of those keys.
 *
 * Returning `true` for them was the obvious implementation and it is wrong in a way worth
 * spelling out. A gate that always passes still *exists*: the call site reads as a paywall,
 * a reviewer sees a check being made, and the day somebody tidies up the special case the
 * paywall switches on. Refusing the question means the wrong call site cannot be written and
 * still compile-and-run — the failure lands on the developer writing it, in development,
 * which is the only place it is cheap. `verify:entitlements` asserts every one of the keys
 * still throws.
 *
 * ## Nothing is gated today, and that is the honest state
 *
 * Every feature key names something that does not exist yet — Distill (C4), the Eval Lab
 * (D), MCP authoring (RM.3) — because each of those was blocked on there being an
 * entitlement to check. The one live consumer is the MCP rate-limit scope. So the free-tier
 * guarantee currently holds by construction *and* by mechanism, which is a stronger position
 * than it was an hour ago and a weaker one than it will be.
 */

/** Thrown by the gate. Carries the upgrade answer, because an agent needs one. */
export class EntitlementError extends Error {
  readonly feature: Feature;
  readonly plan: Plan;
  readonly requires: Plan | null;

  constructor(feature: Feature, plan: Plan) {
    const requires = lowestPlanFor(feature);
    super(
      requires
        ? `This needs the ${requires} plan; this workspace is on ${plan}.`
        : `This is not available on any plan yet.`,
    );
    this.name = "EntitlementError";
    this.feature = feature;
    this.plan = plan;
    this.requires = requires;
  }
}

/**
 * Thrown when a caller asks whether a *trust surface* is entitled.
 *
 * A separate error type from the one above, because they mean opposite things: that one is a
 * customer who needs to upgrade, this one is a bug in our own code that would have broken a
 * standing commitment. Conflating them would let a `catch` meant for the first quietly
 * swallow the second.
 */
export class UngateableError extends Error {
  constructor(key: string) {
    super(
      `"${key}" is a free-tier trust surface and cannot be gated (RC.1). ` +
        `It is hard-coded exempt: verdicts, provenance, quarantine status, the capability ` +
        `surface, the quality score, licence posture, registry reads and permitted ` +
        `downloads are free on every plan, for ever. If you are trying to gate something ` +
        `adjacent to one of these, add a new feature key in src/lib/plans.ts and name it ` +
        `for the thing you are actually gating.`,
    );
    this.name = "UngateableError";
  }
}

/**
 * The plan in force for an organisation, honouring expiry.
 *
 * Read with the plain handle, which the table's open SELECT policy permits — and that
 * openness is not a shortcut, it is required: the MCP surface resolves a token's plan
 * *before* any organisation scope has been set, exactly as `mcp_tokens` is looked up before
 * the organisation is known. The write side stays org-scoped.
 *
 * The near-miss worth recording: the first version wrapped this in `withExplicitOrgScope`
 * against an all-scopes policy, which would have made every unscoped caller see no row and
 * therefore read as `free`. A permissions failure disguised as data — the same shape as
 * `validatePending` selecting unscoped and having RLS answer `org_id IS NULL` only.
 */
export async function planFor(organizationId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: orgEntitlements.plan, validUntil: orgEntitlements.validUntil })
    .from(orgEntitlements)
    .where(eq(orgEntitlements.organizationId, organizationId))
    .limit(1);

  // Absent row means free — see the note on the table. This is what makes a fresh
  // deployment gate nothing.
  if (!row) return DEFAULT_PLAN;

  /**
   * Expiry is read here rather than swept by a job.
   *
   * A background task that downgrades lapsed plans is a task that can fail, and its failure
   * mode is a customer keeping what they stopped paying for. Deciding at read time cannot
   * drift, for the same reason the lifecycle's `stale` is derived rather than stored.
   */
  if (row.validUntil && row.validUntil.getTime() <= Date.now()) return DEFAULT_PLAN;

  return isPlan(row.plan) ? row.plan : DEFAULT_PLAN;
}

/**
 * Whether an organisation may use a feature.
 *
 * Throws `UngateableError` for a trust surface, and for an unknown key: a typo silently
 * answering `false` would be a feature nobody can use and nobody can find, which is worse
 * than a crash in development.
 */
export async function hasEntitlement(
  organizationId: string | null,
  feature: string,
): Promise<boolean> {
  if (isFreeForever(feature)) throw new UngateableError(feature);
  if (!isFeature(feature)) {
    throw new Error(`Unknown feature "${feature}". Add it to FEATURES in src/lib/plans.ts.`);
  }
  // No organisation means no entitlement. An anonymous caller reaching a gated feature is
  // not on the free plan, it is nowhere — and the paid surfaces are all org-scoped anyway.
  if (!organizationId) return false;

  return planIncludes(await planFor(organizationId), feature);
}

/** The same check, as a guard. Throws `EntitlementError` with the upgrade answer. */
export async function requireEntitlement(
  organizationId: string | null,
  feature: string,
): Promise<void> {
  if (isFreeForever(feature)) throw new UngateableError(feature);
  if (!isFeature(feature)) {
    throw new Error(`Unknown feature "${feature}". Add it to FEATURES in src/lib/plans.ts.`);
  }
  const plan = organizationId ? await planFor(organizationId) : DEFAULT_PLAN;
  if (!planIncludes(plan, feature)) throw new EntitlementError(feature, plan);
}

export type SetPlanInput = {
  organizationId: string;
  plan: Plan;
  note?: string | null;
  validUntil?: Date | null;
  actorId: string;
  /**
   * Who the actor is, for the audit row. Defaults to `user`, which every caller was until RC.4.
   *
   * A billing webhook has no user behind it, and recording one would make the log confidently
   * wrong about who changed a customer's plan — the same reason the flag intake writes `system`
   * with `public.flag` rather than inventing an account.
   */
  actorType?: "user" | "system" | "analyzer" | "api_key";
};

/**
 * Set an organisation's plan, with its audit event, in one transaction.
 *
 * `server-only`, explicit `actorId`, never `"use server"` — the rule every function taking an
 * explicit organisation id follows here. The caller resolves the session and proves it is an
 * admin; this validates the arguments and records what happened.
 *
 * RC.4 will drive this from a billing webhook and needs nothing new: the webhook resolves an
 * organisation, calls this, and the idempotency it requires falls out of the upsert.
 */
/**
 * Who to record in `granted_by`, which is a foreign key to a real account.
 *
 * A webhook, a CLI or an analyzer has no user behind it, and writing its name here is refused by
 * the key — **which is the key doing its job.** `verify:models` already paid for this exact
 * lesson: its actor was the string `"verify-script"` and `platform_settings.updated_by` correctly
 * rejected it, because a change has to be attributable to somebody who exists.
 *
 * So the column holds a user or nothing, and the *audit row* carries the real actor — `system` /
 * `billing.webhook` — where there is no key to satisfy and every kind of actor can be named
 * honestly. Two fields, two jobs: one is a reference, the other is a record.
 */
function grantedBy(input: SetPlanInput): string | null {
  return (input.actorType ?? "user") === "user" ? input.actorId : null;
}

export async function setPlan(input: SetPlanInput): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPlan(input.plan)) return { ok: false, error: `Not a plan: ${String(input.plan)}` };
  if (input.validUntil && input.validUntil.getTime() <= Date.now()) {
    return { ok: false, error: "An expiry in the past would grant nothing. Leave it empty instead." };
  }

  const before = await planFor(input.organizationId);

  await db.transaction(async (tx) => {
    /**
     * The write policy is org-scoped, so the scope has to be declared or the INSERT is
     * refused — and refused *silently*, as a zero-row result, which is the failure the
     * `recordUsage` bug taught this codebase the hard way: it wrote unscoped, RLS rejected
     * every row, and because the function swallowed its own failures the refusal was a log
     * line nobody read.
     */
    await tx.execute(sql`select set_config('app.org_id', ${input.organizationId}, true)`);
    await tx
      .insert(orgEntitlements)
      .values({
        organizationId: input.organizationId,
        plan: input.plan,
        note: input.note ?? null,
        grantedBy: grantedBy(input),
        validUntil: input.validUntil ?? null,
      })
      .onConflictDoUpdate({
        target: orgEntitlements.organizationId,
        set: {
          plan: input.plan,
          note: input.note ?? null,
          grantedBy: grantedBy(input),
          validUntil: input.validUntil ?? null,
          updatedAt: new Date(),
        },
      });

    await tx.insert(events).values({
      orgId: input.organizationId,
      actorType: input.actorType ?? "user",
      actorId: input.actorId,
      kind: "entitlement.changed",
      subjectType: "organization",
      subjectId: input.organizationId,
      reason: input.note ?? null,
      payload: {
        from: before,
        to: input.plan,
        validUntil: input.validUntil?.toISOString() ?? null,
      },
    });
  });

  return { ok: true };
}

export type PlanRosterRow = {
  organizationId: string;
  name: string;
  slug: string | null;
  plan: Plan;
  note: string | null;
  validUntil: Date | null;
  members: number;
};

/**
 * Every workspace with its plan, for the admin panel. Admin-only by its caller.
 *
 * Left-joined from `organization`, not from `org_entitlements`, so a workspace that has
 * never been given a plan still appears — as `free`, which is what it is. Driving the list
 * from the entitlements table would show only workspaces somebody had already touched,
 * which is the opposite of what an operator needs from this screen.
 */
export async function planRoster(): Promise<PlanRosterRow[]> {
  /**
   * A cross-organisation read, which the table's open SELECT policy exists to permit.
   *
   * Safe because of the column list — a plan name, an admin's own note, who granted it and
   * when it lapses — and never tenant content. `builder_signals` rests on the same argument
   * and its migration says so: add a column carrying customer data and this becomes wrong.
   */
  const rows = await db
    .select({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan: orgEntitlements.plan,
      note: orgEntitlements.note,
      validUntil: orgEntitlements.validUntil,
      members: sql<number>`(select count(*)::int from member m where m.organization_id = ${organization.id})`,
    })
    .from(organization)
    .leftJoin(orgEntitlements, eq(orgEntitlements.organizationId, organization.id))
    .orderBy(organization.name);

  return rows.map((row) => ({
    organizationId: row.organizationId,
    name: row.name,
    slug: row.slug ?? null,
    // An absent row is `free`, and so is an expired one — the same rule `planFor` applies,
    // so the panel cannot show a plan the gate would refuse to honour.
    plan:
      row.plan && isPlan(row.plan) && !(row.validUntil && row.validUntil.getTime() <= Date.now())
        ? row.plan
        : DEFAULT_PLAN,
    note: row.note ?? null,
    validUntil: row.validUntil ?? null,
    members: row.members,
  }));
}

/** The keys that may never be gated, re-exported so a caller need not reach into `lib`. */
export { FREE_FOREVER };
