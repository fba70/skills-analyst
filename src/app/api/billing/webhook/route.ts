import { NextResponse } from "next/server";

import { handleBillingEvent, verifySignature } from "@/server/billing/webhook";

/**
 * The billing webhook endpoint (Doc 2 RC.4, plan step F2).
 *
 * ## Why this is a route handler, for the fourth documented time
 *
 * Queries live under `src/server` and route handlers get none — both hold. This file imports one
 * server module and touches no database module, no query builder and no driver.
 *
 * A webhook is a **wire protocol**: a third party POSTs a signed body and reads a status code. A
 * server component renders HTML and a server action returns a value to our own bundle, so neither
 * can receive one — the same exception the download route, the MCP endpoint and the interview
 * stream each take, for the same stated reason.
 *
 * ## The raw body, before anything touches it
 *
 * The signature covers the **exact bytes** the provider sent. Parsing first and re-serialising
 * gives different bytes — different key order, different number formatting — so the signature
 * would never verify, and the failure would look like a misconfigured secret rather than like a
 * bug here. `request.text()` first, always.
 *
 * ## What it returns, and why a refusal is still a 200
 *
 * A verified delivery we chose not to act on — an unknown customer, an event type with no rule,
 * one that arrived out of order — returns **200**. Providers retry on any non-2xx, so answering
 * 4xx to a delivery that is *correctly* doing nothing turns one ignorable event into an infinite
 * retry loop and eventually into a disabled endpoint. The outcome is in the body and in a
 * `billing_events` row; the status code is for the retry policy, not for us.
 *
 * 400 is reserved for a delivery that did not verify, which is the only case where retrying is
 * genuinely pointless and the sender genuinely needs to know.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const verified = verifySignature(
    rawBody,
    request.headers.get("stripe-signature"),
    process.env.BILLING_WEBHOOK_SECRET,
  );

  if (!verified.ok) {
    /*
     * Nothing is recorded for an unverified delivery, deliberately.
     *
     * The endpoint is public, so anybody can POST to it — writing a row per attempt would let a
     * stranger fill the table, and an "invalid" row we cannot attribute to a provider is not
     * evidence of anything. The refusal is a log line and a 400.
     */
    console.warn("[billing] rejected a delivery:", verified.reason);
    return NextResponse.json({ error: verified.reason }, { status: 400 });
  }

  const result = await handleBillingEvent(verified.event);
  return NextResponse.json({ received: true, outcome: result.outcome, detail: result.detail });
}
