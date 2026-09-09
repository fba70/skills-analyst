import "dotenv/config";

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "pg";

import {
  isLapsed,
  isPlanEvent,
  planFromMetadata,
  WEBHOOK_OUTCOME_META,
  WEBHOOK_OUTCOMES,
  WEBHOOK_TOLERANCE_SECONDS,
} from "../src/lib/billing";
import { isPlan } from "../src/lib/plans";
import { verifySignature } from "../src/server/billing/webhook";

/**
 * A billing webhook proves who sent it, and refuses one that arrived late (Doc 2 RC.4, step F2).
 *
 *   pnpm verify:billing
 *
 * Free, and the signature half needs no database and no network — it signs its own fixtures with
 * a throwaway secret, which is the only way to test a verifier without a provider account.
 *
 * ## The two properties this file exists to protect
 *
 * 1. **A delivery that did not come from the provider changes nothing.** Forged signature, no
 *    signature, no configured secret, a replayed body — four refusals, and the suite constructs a
 *    genuinely valid signature first so that the refusals are proven to be refusals of something
 *    the verifier would otherwise accept.
 * 2. **A late delivery does not downgrade a paying customer.** This is the half the plan's own
 *    note missed: *"its upsert already tolerates late and duplicate delivery"* is true of a
 *    duplicate and false of a late one. Providers retry, retries arrive out of order, and a
 *    `deleted` landing after the `updated` that upgraded somebody would cancel their plan — with
 *    both writes equally valid in isolation, so no upsert can see it.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const SECRET = "whsec_verify_billing_probe";
const now = Date.now();

function sign(body: string, secret = SECRET, at = Math.floor(now / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${signature}`;
}

const body = JSON.stringify({
  id: "evt_probe_1",
  type: "customer.subscription.updated",
  created: Math.floor(now / 1000),
  data: { object: { customer: "cus_probe", status: "active" } },
});

console.info("\nA valid delivery verifies — so the refusals below mean something");

const good = verifySignature(body, sign(body), SECRET, now);
check("a correctly signed body is accepted", good.ok, good.ok ? good.event.id : good.reason);

console.info("\nAnd four things are refused");

const forged = verifySignature(body, sign(body, "whsec_the_wrong_secret"), SECRET, now);
check("a signature made with the wrong secret", !forged.ok, forged.ok ? "accepted!" : forged.reason);

check(
  "a body altered after signing",
  !verifySignature(body.replace("active", "canceled"), sign(body), SECRET, now).ok,
  "the signature covers the exact bytes, which is why the raw body is read before anything parses it",
);

const stale = verifySignature(
  body,
  sign(body, SECRET, Math.floor(now / 1000) - WEBHOOK_TOLERANCE_SECONDS - 60),
  SECRET,
  now,
);
check(
  "a replay of a delivery older than the window",
  !stale.ok,
  `a signature never expires, so without a window a captured request works for ever (${WEBHOOK_TOLERANCE_SECONDS}s)`,
);

check(
  "and any delivery at all when no secret is configured",
  !verifySignature(body, sign(body), undefined, now).ok,
  "the CRON_SECRET rule: refusing on absence is the only safe default",
);
check("a missing header is refused rather than skipped", !verifySignature(body, null, SECRET, now).ok);
check(
  "a malformed header is refused rather than parsed loosely",
  !verifySignature(body, "not-a-signature", SECRET, now).ok,
);

console.info("\nNo new dependency was taken to do that");

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
check(
  "no payment-provider SDK is a dependency",
  !Object.keys(pkg.dependencies).some((name) => /stripe|paddle|lemonsqueezy|braintree/i.test(name)),
  "an HMAC and a constant-time compare are twenty lines of node:crypto, on a security-critical path",
);

console.info("\nThe vocabulary, and what it refuses to assume");

check(
  "every outcome has its own sentence",
  new Set(WEBHOOK_OUTCOMES.map((o) => WEBHOOK_OUTCOME_META[o].blurb)).size === WEBHOOK_OUTCOMES.length,
  `${WEBHOOK_OUTCOMES.length} outcomes`,
);
check(
  "a duplicate is described as normal, not as a fault",
  WEBHOOK_OUTCOME_META.duplicate.blurb.includes("normal"),
  "providers retry until they get a 2xx, so duplicates are most of the traffic",
);
check(
  "only subscription events change a plan",
  isPlanEvent("customer.subscription.deleted") && !isPlanEvent("invoice.paid"),
  "an allow-list, because a provider adds event types and the default must be to do nothing",
);
check(
  "a cancelled subscription is the one downgrade path",
  isLapsed("canceled") && isLapsed("unpaid") && !isLapsed("active"),
);

/*
 * The asymmetry that matters, and it is the mirror of `UNKNOWN_MODEL_RATE`.
 *
 * An unknown model over-charges on purpose, because a budget that ignores what it cannot price is
 * not a budget. An unknown *plan* must under-act, because defaulting to `free` would cancel a
 * paying customer's plan over a missing metadata field in somebody's dashboard.
 */
check(
  "a subscription with no plan metadata yields null, never `free`",
  planFromMetadata({}, isPlan) === null &&
    planFromMetadata({ plan: "not-a-plan" }, isPlan) === null &&
    planFromMetadata({ plan: "pro" }, isPlan) === "pro",
  "defaulting to free would downgrade somebody because a field was forgotten",
);

console.info("\nStored rows");

const c = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
let connected = false;
try {
  await c.connect();
  connected = true;
} catch {
  console.info("  skip  no database connection — the pure checks above are complete");
}

if (connected) {
  const { rows: exists } = await c.query<{ present: boolean }>(
    `select to_regclass('public.billing_events') is not null as present`,
  );
  if (!exists[0].present) {
    console.info("  skip  table absent — the migration is not applied yet");
  } else {
    const { rows: columns } = await c.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'billing_events'`,
    );
    check(
      "no column holds the payload",
      !columns.some((col) => /payload|body|raw|email|name/.test(col.column_name)),
      "a subscription body carries names, addresses and card metadata",
    );
    check(
      "the idempotency key is an index, not a convention",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes
            where tablename = 'billing_events' and indexdef ilike '%unique%'
              and indexdef ilike '%event_id%'`,
        )
      ).rows[0].n === "1",
    );
    check(
      "one workspace per billing customer, enforced",
      (
        await c.query<{ n: string }>(
          `select count(*)::text as n from pg_indexes
            where tablename = 'org_entitlements' and indexdef ilike '%billing_customer_id%'
              and indexdef ilike '%unique%'`,
        )
      ).rows[0].n === "1",
      "two workspaces on one customer would upgrade whichever the query returned first",
    );

    const { rows: org } = await c.query<{ id: string }>(`select id from organization limit 1`);
    if (org.length === 0) {
      console.info("  skip  no organisation to link a probe customer to");
    } else {
      const orgId = org[0].id;
      const customerId = `cus_verify_${Date.now()}`;
      const { handleBillingEvent } = await import("../src/server/billing/webhook");

      const event = (id: string, createdAt: number, status: string, plan: string | null) => ({
        id,
        type: "customer.subscription.updated",
        created: createdAt,
        data: {
          object: {
            customer: customerId,
            status,
            items: { data: [{ price: { metadata: plan ? { plan } : {} } }] },
          },
        },
      });

      try {
        /* Unmapped first, before the link exists — the honest answer to an unknown customer. */
        const unmapped = await handleBillingEvent(event("evt_v_0", Math.floor(now / 1000), "active", "pro"));
        check(
          "an unknown customer is recorded as unmapped rather than guessed at",
          unmapped.outcome === "unmapped",
          unmapped.outcome,
        );

        await c.query(
          `insert into org_entitlements (organization_id, plan, billing_provider, billing_customer_id)
             values ($1, 'free', 'stripe', $2)
           on conflict (organization_id) do update
             set billing_provider = 'stripe', billing_customer_id = $2`,
          [orgId, customerId],
        );

        const t0 = Math.floor(now / 1000);
        const applied = await handleBillingEvent(event("evt_v_1", t0, "active", "pro"));
        check("a linked customer's upgrade is applied", applied.outcome === "applied", applied.detail);

        const { rows: plan } = await c.query<{ plan: string; granted_by: string | null }>(
          `select plan, granted_by from org_entitlements where organization_id = $1`,
          [orgId],
        );
        check("and the plan really changed", plan[0].plan === "pro", plan[0].plan);
        /*
         * `granted_by` is a foreign key to a real account, and a webhook is not one.
         *
         * The first version of this handler wrote `"billing.webhook"` there and Postgres refused
         * the whole transaction — the key doing its job, and the identical lesson `verify:models`
         * recorded when its actor was the string `"verify-script"`. The column holds a user or
         * nothing; the audit row below is where the real actor is named.
         */
        check(
          "a system actor leaves granted_by null rather than inventing an account",
          plan[0].granted_by === null,
          plan[0].granted_by ?? "null",
        );
        const { rows: audit } = await c.query<{ actor_type: string; actor_id: string }>(
          `select actor_type, actor_id from events
            where kind = 'entitlement.changed' and org_id = $1
            order by at desc limit 1`,
          [orgId],
        );
        check(
          "but the audit row names it exactly",
          audit[0]?.actor_type === "system" && audit[0]?.actor_id === "billing.webhook",
          `${audit[0]?.actor_type} / ${audit[0]?.actor_id}`,
        );

        const again = await handleBillingEvent(event("evt_v_1", t0, "active", "pro"));
        check(
          "the same delivery twice is a duplicate, not a second change",
          again.outcome === "duplicate",
          again.outcome,
        );

        /*
         * The one the plan's note missed. A cancellation that *happened before* the upgrade,
         * arriving after it — which is exactly what a ninety-second retry delay produces.
         */
        const late = await handleBillingEvent(event("evt_v_2", t0 - 90, "canceled", null));
        check(
          "a delivery older than the applied change is refused",
          late.outcome === "stale",
          late.outcome,
        );
        const { rows: still } = await c.query<{ plan: string }>(
          `select plan from org_entitlements where organization_id = $1`,
          [orgId],
        );
        check(
          "and the paying customer is still on their plan",
          still[0].plan === "pro",
          `an upsert cannot see this: both writes are valid in isolation (${still[0].plan})`,
        );

        const missing = await handleBillingEvent(event("evt_v_3", t0 + 60, "active", null));
        check(
          "a subscription with no plan metadata changes nothing",
          missing.outcome === "ignored",
          missing.detail,
        );

        const cancelled = await handleBillingEvent(event("evt_v_4", t0 + 120, "canceled", null));
        check("a genuine later cancellation is applied", cancelled.outcome === "applied");
        const { rows: downgraded } = await c.query<{ plan: string }>(
          `select plan from org_entitlements where organization_id = $1`,
          [orgId],
        );
        check("and it lands on free", downgraded[0].plan === "free", downgraded[0].plan);
      } finally {
        await c.query(`delete from billing_events where customer_id = $1`, [customerId]);
        await c.query(
          `update org_entitlements set plan = 'free', billing_customer_id = null, billing_provider = null
            where organization_id = $1`,
          [orgId],
        );
        await c.query(
          `delete from events where kind = 'entitlement.changed' and actor_id = 'billing.webhook'
             and at > now() - interval '10 minutes'`,
        );
        const { rows: left } = await c.query<{ n: string }>(
          `select count(*)::text as n from billing_events where customer_id like 'cus_verify_%'`,
        );
        check("the probe left nothing behind", left[0].n === "0", `${left[0].n} rows`);
      }
    }
  }
  await c.end();
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
