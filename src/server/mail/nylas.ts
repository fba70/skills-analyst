import "server-only";
import { fetchWithDeadline } from "@/server/http/deadline";

import { otpHtml, otpSubject } from "./templates";
import type { MailTransport, OtpEmail } from "./types";

/**
 * Nylas v3, over its REST API.
 *
 * Plain `fetch` rather than the SDK: one endpoint, one POST, and it keeps the function
 * bundle small — the same reasoning as `aws4fetch` for R2, and as the Resend transport this
 * replaces.
 *
 * ## Nylas sends *from a mailbox*, not from a domain
 *
 * This is the difference that matters, and it is why the switch was worth making. Resend
 * needs a verified sending domain before it will deliver to anyone but the account owner;
 * a Nylas grant is an already-authenticated mailbox, so mail leaves as that mailbox under
 * its existing SPF and DKIM. `NYLAS_GRANT_ID` names it. There is no domain to verify and no
 * shared sender that quietly reaches exactly one address.
 *
 * `MAIL_FROM` therefore changes meaning: it is an **override**, not the sender. Providers
 * refuse an override that is not a configured send-as alias of the granted mailbox, so
 * leaving it unset is the safe default — and the error path below names it, because
 * "invalid sender" on a value someone set months ago is otherwise a long afternoon.
 *
 * ## One body, and what that costs
 *
 * The v3 send endpoint takes a single `body` with an `is_plaintext` flag: HTML *or* text,
 * never a multipart alternative. The plain-text part that shipped alongside every Resend
 * message cannot be sent, and `otpText` went with it.
 *
 * HTML is the right side of that trade here, but only because of how the template is
 * built: the code is real letter-spaced text in the markup, not an image and not a
 * background, so a client that strips the HTML still yields a readable code. Put the digits
 * in an image and this choice would stop being acceptable.
 *
 * The send is awaited and failures throw, so a misconfigured grant surfaces as a visible
 * error instead of a user waiting for a code that was never sent. Better Auth's docs
 * suggest not awaiting, to avoid leaking whether an address exists through response time —
 * that concern does not apply here, because sign-up and sign-in are the same flow: an
 * unknown address is valid and creates an account, so there is nothing to enumerate.
 */

/** Nylas is region-partitioned; `NYLAS_API_URI` picks the one the grant lives in. */
const DEFAULT_API_URI = "https://api.us.nylas.com";

export type NylasConfig = {
  apiKey: string;
  grantId: string;
  apiUri: string;
};

/**
 * Splits `Name <someone@example.com>` into what the API wants, and accepts a bare address.
 *
 * Nylas takes participants as `{ name, email }` objects, so the RFC display-name form that
 * every other mail service accepts as one string has to be taken apart here. Passing the
 * whole string as `email` produces a 400 that reads like an invalid address rather than a
 * wrongly shaped request.
 */
export function parseParticipant(value: string): { name?: string; email: string } {
  const match = value.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, "").trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return { email: value.trim() };
}

export function readNylasConfig(): NylasConfig | null {
  const apiKey = process.env.NYLAS_API_KEY?.trim();
  const grantId = process.env.NYLAS_GRANT_ID?.trim();
  if (!apiKey || !grantId) return null;

  // Trailing slash stripped: the path below starts with one, and `//v3/...` 404s in a way
  // that reads like a wrong region rather than a wrong string.
  const apiUri = (process.env.NYLAS_API_URI?.trim() || DEFAULT_API_URI).replace(/\/+$/, "");
  return { apiKey, grantId, apiUri };
}

export function createNylasTransport(config: NylasConfig): MailTransport {
  const from = process.env.MAIL_FROM?.trim();
  const endpoint = `${config.apiUri}/v3/grants/${encodeURIComponent(config.grantId)}/messages/send`;

  return {
    name: "nylas",

    async sendOtp(mail: OtpEmail): Promise<void> {
      /**
       * No `Idempotency-Key`, and the reasoning is worth keeping because the header looks
       * free and is not.
       *
       * The first version sent one, hashed from recipient, purpose and code, to stop a
       * retry delivering a second copy of a code the user already has. Nylas remembers
       * that key. Two 6-digit codes for the same address and purpose therefore collide
       * roughly once in a million sends — and on collision Nylas treats the second send as
       * a duplicate and **delivers nothing**, silently, to someone waiting to sign in.
       *
       * The alternative is a random key per call, which is unique by construction and so
       * provides no idempotency at all. There is no middle: the key is either stable
       * enough to be useful or unique enough to be safe.
       *
       * What it was guarding against is also hypothetical. Better Auth runs
       * `sendVerificationOTP` as a background task and swallows the throw — it does not
       * retry. Trading a real silent-non-delivery path for a speculative duplicate is the
       * wrong way round, and a duplicate code is a far better failure than no code.
       */
      const response = await fetchWithDeadline(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          to: [{ email: mail.to }],
          ...(from ? { from: [parseParticipant(from)] } : {}),
          subject: otpSubject(mail.purpose),
          body: otpHtml(mail.code, mail.purpose, mail.expiresInMinutes),
          /**
           * `tracking_options` is **omitted**, not set to false.
           *
           * Two reasons, and the second was found the hard way. Open and link tracking
           * rewrite the message with a pixel and redirect URLs, which on a one-time
           * passcode buys nothing — there is one link, and whether it was opened is not a
           * question worth a beacon in a message about signing in.
           *
           * And a trial Nylas account rejects the *field itself* with
           * `api.invalid_request_error: Tracking options are not allowed for trial
           * accounts`, whatever the values are. Sending `{ opens: false }` to say "no
           * tracking" therefore fails the send outright. Absence says the same thing and
           * says it on every plan.
           */
        }),
      });

      const text = await response.text().catch(() => "");

      if (!response.ok) {
        const detail = parseError(text);
        /**
         * The sender hint is attached only when the failure is about the sender.
         *
         * It fired unconditionally at first, and the very first real failure was about
         * `tracking_options` — so the message blamed `MAIL_FROM`, which was correct
         * configuration, and pointed at the wrong file. A hint that appears on every error
         * is not a hint, it is noise that costs someone an afternoon.
         */
        const senderProblem = /\bfrom\b|sender|alias|send.as|not allowed to send/i.test(detail);
        // The recipient is safe to log; the code is not, and is never included.
        throw new Error(
          `Nylas rejected the message to ${mail.to}: ${response.status} ${detail}` +
            (from && senderProblem
              ? ` (MAIL_FROM is "${from}" — a provider refuses a sender that is not a` +
                ` configured send-as alias of the granted mailbox; unset it to send as the` +
                ` mailbox itself)`
              : ""),
        );
      }

      /**
       * A 200 means Nylas accepted it, not that it arrived.
       *
       * The provider can still bounce or drop the message afterwards, and `request_id` is
       * what the Nylas dashboard is searched by when that happens. Logging the message id
       * alone identifies a message we can no longer trace back to a single API call.
       */
      let ids = "id=unknown request_id=unknown";
      try {
        const parsed = JSON.parse(text) as {
          request_id?: string;
          data?: { id?: string };
        };
        ids = `id=${parsed.data?.id ?? "unknown"} request_id=${parsed.request_id ?? "unknown"}`;
      } catch {
        /* keep the placeholder — a 200 with an unreadable body is still a send */
      }
      console.info(`[mail] nylas accepted ${ids} to=${mail.to}`);
    },
  };
}

/** Nylas errors are `{ request_id, error: { type, message } }`; anything else passes through. */
function parseError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      request_id?: string;
      error?: { type?: string; message?: string } | string;
    };
    const error = parsed.error;
    const message =
      typeof error === "string" ? error : [error?.type, error?.message].filter(Boolean).join(": ");
    if (message) {
      return `${message}${parsed.request_id ? ` (request_id ${parsed.request_id})` : ""}`;
    }
  } catch {
    /* fall through to the raw body */
  }
  return body.slice(0, 300) || "(no response body)";
}
