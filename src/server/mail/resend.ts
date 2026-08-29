import "server-only";

import { otpHtml, otpSubject, otpText } from "./templates";
import type { MailTransport, OtpEmail } from "./types";

/**
 * Resend, over its REST API.
 *
 * Plain `fetch` rather than the SDK: one endpoint, one POST, and it keeps the function
 * bundle small — the same reasoning as `aws4fetch` for R2.
 *
 * The send is awaited and failures throw, so a misconfigured sender surfaces as a visible
 * error instead of a user waiting for a code that was never sent. Better Auth's docs
 * suggest not awaiting, to avoid leaking whether an address exists through response time
 * — that concern does not apply here, because sign-up and sign-in are the same flow: an
 * unknown address is valid and creates an account, so there is nothing to enumerate.
 */

const ENDPOINT = "https://api.resend.com/emails";

/** Resend's shared sender. Works with no domain setup, but only delivers to the
 *  address that owns the Resend account — fine for a first test, not for real users. */
const DEFAULT_FROM = "Skill Foundry <onboarding@resend.dev>";

export function createResendTransport(apiKey: string): MailTransport {
  const from = process.env.MAIL_FROM?.trim() || DEFAULT_FROM;

  return {
    name: "resend",

    async sendOtp(mail: OtpEmail): Promise<void> {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [mail.to],
          subject: otpSubject(mail.purpose),
          // Both parts, always: some clients render the text alternative.
          text: otpText(mail.code, mail.purpose, mail.expiresInMinutes),
          html: otpHtml(mail.code, mail.purpose, mail.expiresInMinutes),
          headers: {
            // Tells clients this is a transactional message, not something to auto-reply
            // to or file as bulk.
            "X-Entity-Ref-ID": `otp-${mail.purpose}`,
          },
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // The recipient is safe to log; the code is not, and is never included.
        throw new Error(
          `Resend rejected the message to ${mail.to}: ${response.status} ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}
