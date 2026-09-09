/**
 * Billing webhooks (Doc 2 RC.4, plan step F2).
 *
 * A leaf module with no imports, like `plans.ts` beside it: the route, the handler, the admin
 * panel and the verify suite all need one vocabulary for what happened to a delivery.
 *
 * ## What this step is, and what it deliberately is not
 *
 * It is the **receiving** half: an endpoint that can be pointed at a payment provider, prove a
 * delivery came from them, and turn it into the plan change `setPlan` already knows how to make.
 * It is **not** a checkout flow, and choosing and provisioning a provider is a business decision
 * with an account, keys and a dashboard behind it — not something code can settle.
 *
 * Until a checkout exists, nothing tells us which workspace a customer id belongs to, so an
 * unrecognised customer is recorded as `unmapped` rather than guessed at, and an admin links it
 * from the Plans panel. That is a real gap and it is named on the panel rather than left to be
 * discovered when a payment silently changes nothing.
 *
 * ## The plan's own note was half right, and the other half is the hard part
 *
 * *"`setPlan` is already the idempotent write a webhook would call, and its upsert already
 * tolerates late and duplicate delivery."* The upsert is genuinely idempotent for a **duplicate**
 * — applying the same event twice leaves the same row. It is **not** safe for a **late** one.
 *
 * Providers retry, and retries arrive out of order. A `subscription.deleted` delayed by ninety
 * seconds, landing after the `subscription.updated` that upgraded somebody, downgrades a paying
 * customer — an upsert cannot see that, because both writes are equally valid in isolation. So
 * every delivery carries the provider's own event timestamp and one older than the last applied
 * change for that workspace is recorded and refused.
 */

/** What happened to one delivery. Every one of these is a row, including the refusals. */
export const WEBHOOK_OUTCOMES = [
  "applied",
  "duplicate",
  "stale",
  "unmapped",
  "ignored",
  "invalid",
] as const;

export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

export const WEBHOOK_OUTCOME_META: Record<WebhookOutcome, { label: string; blurb: string }> = {
  applied: { label: "Applied", blurb: "The plan changed, with an audit event naming the delivery." },
  duplicate: {
    label: "Duplicate",
    blurb:
      "Already seen. Providers retry until they get a 2xx, so this is the normal case rather than a fault.",
  },
  stale: {
    label: "Out of order",
    blurb:
      "Older than the change already applied to this workspace. Refused — a late delete arriving after an upgrade would downgrade a paying customer.",
  },
  unmapped: {
    label: "Unknown customer",
    blurb:
      "No workspace is linked to this billing customer, so there was nothing to change. Link it from the Plans panel.",
  },
  ignored: {
    label: "Not a plan change",
    blurb: "A delivery we have no rule for. Recorded so the endpoint is never silently doing nothing.",
  },
  invalid: {
    label: "Rejected",
    blurb: "The signature did not verify, or the delivery was too old to accept.",
  },
};

/**
 * How long after its own timestamp a delivery is still accepted.
 *
 * Replay protection: a signature stays valid for ever, so a captured request could be replayed
 * indefinitely without a window. Five minutes is the provider convention and is generous against
 * clock skew while leaving a captured body useless by the time anybody has it.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The event types that change a plan. Everything else is recorded as `ignored`.
 *
 * An allow-list rather than a switch with a default: a provider adds event types over time, and
 * the failure mode of "handle anything that looks like a subscription" is acting on a delivery
 * nobody designed for.
 */
export const PLAN_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export function isPlanEvent(type: string): boolean {
  return (PLAN_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Which plan a subscription grants, read from the price's own metadata.
 *
 * `metadata.plan` on the price or product, set in the provider's dashboard beside the money. The
 * alternative is a price-id → plan map in our config, which is a second place the commercial
 * truth lives and the one that goes stale when somebody adds a currency or an annual tier.
 *
 * An unrecognised value returns null and the delivery is recorded as `ignored` rather than
 * defaulting to `free` — a missing label is not a downgrade, and treating it as one would cancel
 * a customer's plan because somebody forgot a metadata field.
 */
export function planFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  isPlan: (value: unknown) => boolean,
): string | null {
  const value = metadata?.plan;
  return typeof value === "string" && isPlan(value) ? value : null;
}

/**
 * A cancelled or unpaid subscription is `free`, and that is the one downgrade path.
 *
 * Stated here rather than inline so there is exactly one answer to "what does a lapsed
 * subscription mean" — the same reason `BATTLE_TESTED` holds its thresholds where the FAQ can
 * read them instead of leaving them in the SQL.
 */
export const LAPSED_STATUSES = ["canceled", "unpaid", "incomplete_expired"] as const;

export function isLapsed(status: string | null | undefined): boolean {
  return typeof status === "string" && (LAPSED_STATUSES as readonly string[]).includes(status);
}
