import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import {
  isLapsed,
  isPlanEvent,
  planFromMetadata,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookOutcome,
} from "@/lib/billing";
import { isPlan } from "@/lib/plans";
import { db } from "@/server/db";
import { billingEvents, orgEntitlements } from "@/server/db/schema";

/**
 * Receiving a billing webhook (Doc 2 RC.4, plan step F2).
 *
 * The reasoning is in `src/lib/billing.ts`. Three things this file is responsible for:
 * proving a delivery came from the provider, refusing one that arrived out of order, and turning
 * what is left into the `setPlan` call the platform already knows how to make.
 *
 * ## No new dependency, deliberately
 *
 * Verifying a webhook signature is an HMAC over `timestamp.body` and a constant-time compare —
 * twenty lines of `node:crypto`. Taking a provider SDK to do it would mean taking its release
 * cadence on a **security-critical path** for code that does not change, and this repo's second
 * hard rule exists precisely so that trade is made deliberately rather than by reflex.
 *
 * It also keeps the verifier isolated: a different provider is a second `verifySignature`, not a
 * rewrite of the handler.
 */

export const BILLING_PROVIDER = "stripe";

export type VerifyResult =
  | { ok: true; event: ProviderEvent }
  | { ok: false; reason: string };

/**
 * A provider event, narrowed to what this handler reads.
 *
 * Deliberately not the provider's full type. Everything absent from this shape is something the
 * handler cannot act on by accident, and the payload is never stored — see the table comment.
 */
export type ProviderEvent = {
  id: string;
  type: string;
  created: number;
  data: {
    object: {
      customer?: string | null;
      status?: string | null;
      items?: { data?: Array<{ price?: { metadata?: Record<string, unknown> | null } | null }> };
      metadata?: Record<string, unknown> | null;
    };
  };
};

/**
 * Verify a delivery, without an SDK.
 *
 * Three failures, and each is a real attack rather than a formality:
 *
 * - **no secret configured** → refuse. The `CRON_SECRET` rule: a deployment that forgot to set it
 *   is a deployment where an unauthenticated endpoint can change what customers are paying for,
 *   and refusing on absence is the only safe default.
 * - **signature mismatch** → refuse, compared in constant time. A byte-by-byte compare leaks how
 *   much of a forged signature was right, which is enough to construct one.
 * - **too old** → refuse. A signature never expires, so without a window a captured request can
 *   be replayed for ever.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  now = Date.now(),
): VerifyResult {
  if (!secret) return { ok: false, reason: "no signing secret configured" };
  if (!header) return { ok: false, reason: "no signature header" };

  const parts = new Map(
    header.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")] as const;
    }),
  );
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return { ok: false, reason: "malformed signature header" };

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "delivery outside the replay window" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  /* Length is checked first because `timingSafeEqual` throws on a mismatch rather than returning. */
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature did not verify" };
  }

  let event: ProviderEvent;
  try {
    event = JSON.parse(rawBody) as ProviderEvent;
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (!event.id || !event.type || typeof event.created !== "number") {
    return { ok: false, reason: "event is missing id, type or created" };
  }
  return { ok: true, event };
}

export type HandleResult = { outcome: WebhookOutcome; detail?: string };

/**
 * Apply one verified delivery.
 *
 * Every path writes a `billing_events` row, including the ones that change nothing. An endpoint
 * that only records its successes is one where *"we never received it"* and *"we received it and
 * did nothing"* are indistinguishable — the heartbeat's argument, applied to money.
 */
export async function handleBillingEvent(event: ProviderEvent): Promise<HandleResult> {
  const occurredAt = new Date(event.created * 1000);
  const object = event.data?.object ?? {};
  const customerId = typeof object.customer === "string" ? object.customer : null;

  const record = async (
    outcome: WebhookOutcome,
    organizationId: string | null,
    appliedPlan: string | null,
  ) => {
    /*
     * The insert *is* the idempotency check. A retry conflicts on `(provider, event_id)` and the
     * zero-row result is how we learn it is a duplicate — rather than a read-then-write, which
     * two concurrent retries can both pass.
     */
    const rows = await db
      .insert(billingEvents)
      .values({
        provider: BILLING_PROVIDER,
        eventId: event.id,
        eventType: event.type,
        occurredAt,
        customerId,
        organizationId,
        outcome,
        appliedPlan,
      })
      .onConflictDoNothing({ target: [billingEvents.provider, billingEvents.eventId] })
      .returning({ id: billingEvents.id });
    return rows.length > 0;
  };

  if (!isPlanEvent(event.type)) {
    await record("ignored", null, null);
    return { outcome: "ignored", detail: event.type };
  }

  if (!customerId) {
    await record("ignored", null, null);
    return { outcome: "ignored", detail: "no customer on the subscription" };
  }

  const [link] = await db
    .select({ organizationId: orgEntitlements.organizationId })
    .from(orgEntitlements)
    .where(
      and(
        eq(orgEntitlements.billingProvider, BILLING_PROVIDER),
        eq(orgEntitlements.billingCustomerId, customerId),
      ),
    )
    .limit(1);

  if (!link) {
    /*
     * Recorded rather than guessed. Nothing links a customer to a workspace until a checkout
     * flow exists, and inventing the mapping from an email address would be the platform
     * deciding who is paying for what on a string match.
     */
    await record("unmapped", null, null);
    return { outcome: "unmapped", detail: customerId };
  }

  const plan = isLapsed(object.status)
    ? "free"
    : planFromMetadata(
        object.items?.data?.[0]?.price?.metadata ?? object.metadata ?? null,
        isPlan,
      );

  if (!plan) {
    /*
     * A subscription with no plan metadata is not a downgrade.
     *
     * Defaulting to `free` here would cancel a customer's plan because somebody forgot a field in
     * a dashboard — the `rateFor` lesson inverted: an unknown model over-charges deliberately,
     * and an unknown plan must under-act.
     */
    await record("ignored", link.organizationId, null);
    return { outcome: "ignored", detail: "no plan in the price metadata" };
  }

  /*
   * Idempotency is checked **before** ordering, and the order of those two is not cosmetic.
   *
   * A retry carries the *same* timestamp as the delivery it repeats, so with the ordering guard
   * first it trips as `stale` — safe, because nothing changes either way, and **wrong**, because
   * an operator reading `stale` on ordinary retry traffic would conclude their provider was
   * delivering out of order. A confidently wrong diagnostic is worse than a missing one, and
   * duplicates are most of the traffic.
   *
   * Two layers, deliberately. This read labels the common sequential retry correctly; the insert
   * below still carries the real guarantee, because two concurrent retries can both pass a read
   * and only one can win a unique index.
   */
  const [seen] = await db
    .select({ id: billingEvents.id })
    .from(billingEvents)
    .where(
      and(eq(billingEvents.provider, BILLING_PROVIDER), eq(billingEvents.eventId, event.id)),
    )
    .limit(1);
  if (seen) return { outcome: "duplicate", detail: event.id };

  /*
   * The ordering guard, and the reason this step is not just a route.
   *
   * Providers retry, and retries arrive out of order. A `deleted` delayed ninety seconds, landing
   * after the `updated` that upgraded somebody, downgrades a paying customer — and `setPlan`'s
   * upsert cannot see it, because in isolation both writes are equally valid.
   */
  const [newest] = await db
    .select({ occurredAt: billingEvents.occurredAt })
    .from(billingEvents)
    .where(
      and(
        eq(billingEvents.organizationId, link.organizationId),
        eq(billingEvents.outcome, "applied"),
        isNotNull(billingEvents.occurredAt),
      ),
    )
    .orderBy(desc(billingEvents.occurredAt))
    .limit(1);

  /*
   * `>=` rather than `>`, so two distinct events sharing one second are refused rather than
   * racing. Providers timestamp to the second, so that collision is real — and the safe
   * direction is to under-act and record it, since a refused change is visible in the table
   * while a wrongly applied downgrade is visible only on somebody's invoice.
   */
  if (newest && newest.occurredAt >= occurredAt) {
    await record("stale", link.organizationId, null);
    return { outcome: "stale", detail: `older than ${newest.occurredAt.toISOString()}` };
  }

  const fresh = await record("applied", link.organizationId, plan);
  if (!fresh) return { outcome: "duplicate", detail: event.id };

  const { setPlan } = await import("@/server/dal/entitlements");
  const applied = await setPlan({
    organizationId: link.organizationId,
    plan: plan as Parameters<typeof setPlan>[0]["plan"],
    note: `${event.type} · ${event.id}`,
    actorType: "system",
    actorId: "billing.webhook",
  });
  if (!applied.ok) {
    await db
      .update(billingEvents)
      .set({ outcome: "invalid", appliedPlan: null })
      .where(
        and(
          eq(billingEvents.provider, BILLING_PROVIDER),
          eq(billingEvents.eventId, event.id),
        ),
      );
    return { outcome: "invalid", detail: applied.error };
  }

  return { outcome: "applied", detail: plan };
}

/** Deliveries, newest first, for the Plans panel. */
export async function recentBillingEvents(limit = 25) {
  return db
    .select({
      eventId: billingEvents.eventId,
      eventType: billingEvents.eventType,
      occurredAt: billingEvents.occurredAt,
      customerId: billingEvents.customerId,
      organizationId: billingEvents.organizationId,
      outcome: billingEvents.outcome,
      appliedPlan: billingEvents.appliedPlan,
    })
    .from(billingEvents)
    .orderBy(desc(billingEvents.receivedAt))
    .limit(limit);
}

/** Counts per outcome, so an operator can see the endpoint is alive and what it is deciding. */
export async function billingSummary() {
  const rows = await db
    .select({ outcome: billingEvents.outcome, n: sql<number>`count(*)::int` })
    .from(billingEvents)
    .groupBy(billingEvents.outcome);
  const [{ linked }] = await db
    .select({ linked: sql<number>`count(*)::int` })
    .from(orgEntitlements)
    .where(isNotNull(orgEntitlements.billingCustomerId));
  return { rows, linked, configured: Boolean(process.env.BILLING_WEBHOOK_SECRET) };
}
