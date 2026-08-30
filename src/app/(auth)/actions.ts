"use server";

import { headers } from "next/headers";

import { auth } from "@/server/auth";
import { takeSendFailure } from "@/server/auth/send-failures";

/**
 * Asking for a sign-in code, through our own action rather than the auth client.
 *
 * ## Why this is not `authClient.emailOtp.sendVerificationOtp`
 *
 * Because that call cannot fail. Better Auth passes our transport to
 * `runInBackgroundOrAwait`, which awaits it and then catches — the throw is logged and the
 * endpoint answers 200. The browser therefore saw success for every send, including the
 * ones that never left the building, and the form said "Code sent to you@example.com" to
 * someone who would be waiting for ever.
 *
 * The outcome is not missing, only unreachable: the send is awaited, so by the time
 * `auth.api.sendVerificationOTP` returns, we know. This action is the seam that reads it
 * back — `send-failures.ts` carries the reason across the one function call that swallowed
 * it, and `since` guarantees an older failure for the same address cannot leak into a
 * newer attempt.
 *
 * The route itself is unchanged. `auth.api.*` invokes the same endpoint as the client
 * would, so rate limiting, OTP generation and storage all behave exactly as before; the
 * only difference is who reads the result.
 *
 * ## Nothing here distinguishes a known address from an unknown one
 *
 * Sign-in and sign-up are the same flow (`disableSignUp: false`) — an unknown address is
 * valid and creates an account — so there is no account existence to leak and no reason to
 * blur timing or messages. If that ever changes, this action is where it would have to be
 * reconsidered.
 */

export type RequestOtpResult = { ok: true } | { ok: false; message: string };

export async function requestOtpAction(email: string): Promise<RequestOtpResult> {
  const address = email.trim();
  if (!address) return { ok: false, message: "Enter your email address." };

  /**
   * Read before the call, not after it.
   *
   * `takeSendFailure` only accepts a failure recorded at or after this instant, so a
   * previous attempt's error cannot be reported against this one. Capturing the timestamp
   * first is what makes that true.
   */
  const startedAt = Date.now();

  try {
    await auth.api.sendVerificationOTP({
      body: { email: address, type: "sign-in" },
      // Forwarded so the endpoint sees the real request: rate limiting and origin checks
      // are keyed off these, and calling the API without them would quietly exempt this
      // path from both.
      headers: await headers(),
    });
  } catch (error) {
    // A throw here is the endpoint refusing — rate limited, malformed, origin rejected.
    // Distinct from a send failure, which never throws this far.
    return { ok: false, message: messageFor(error) };
  }

  const failure = takeSendFailure(address, startedAt);
  if (failure) {
    // The reason is logged in full server-side. What reaches the browser says what
    // happened and what to do, without quoting a provider error at someone trying to
    // sign in.
    console.error(`[auth] OTP send failed for ${address}: ${failure}`);
    return {
      ok: false,
      message: "We could not send the code. This is our problem, not yours — try again in a moment.",
    };
  }

  return { ok: true };
}

function messageFor(error: unknown): string {
  const message = (error as { message?: string })?.message;
  return message && message.length < 200
    ? message
    : "Could not request a code. Try again.";
}
