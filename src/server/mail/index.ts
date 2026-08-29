import "server-only";

import { createResendTransport } from "./resend";
import { otpSubject } from "./templates";
import type { MailTransport, OtpEmail, OtpPurpose } from "./types";

export type { MailTransport, OtpEmail, OtpPurpose };

/**
 * One interface, one transport chosen at runtime.
 *
 * Selection, in order:
 *   1. `MAIL_TRANSPORT=console` — never send, print instead.
 *   2. RESEND_API_KEY present — send for real.
 *   3. otherwise the console, with a warning if this looks like a deployment.
 *
 * Note what this deliberately does NOT depend on: `VERCEL_ENV`. An earlier version keyed
 * "should we really send?" off that variable, which is a system variable a project can
 * be configured not to expose — and if it is missing, mail silently downgrades to the
 * console and nobody can sign in. Presence of the API key is the honest signal. Local
 * development pins `MAIL_TRANSPORT=console` in .env instead, so a laptop still cannot
 * quietly email people.
 *
 * The chosen transport is logged once, because "which transport is this deployment
 * using" is the first question when mail does not arrive.
 */

const purposeLabel: Record<OtpPurpose, string> = {
  "sign-in": "Sign in",
  "email-verification": "Verify your email",
  "forget-password": "Reset your password",
  "change-email": "Confirm your new email",
};

const consoleTransport: MailTransport = {
  name: "console",
  async sendOtp({ to, code, purpose }) {
    const width = 46;
    const line = "─".repeat(width);
    const row = (text: string) => `│ ${text.padEnd(width - 2)} │`;
    // Deliberately a console write: this IS the dev mail transport.
    console.info(
      [
        "",
        `┌${line}┐`,
        row(`Skill Foundry — ${purposeLabel[purpose]}`),
        row(`to:   ${to}`),
        row(`code: ${code}`),
        `└${line}┘`,
        "",
      ].join("\n"),
    );
  },
};

let cached: MailTransport | null = null;

export function getTransport(): MailTransport {
  if (cached) return cached;

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const override = process.env.MAIL_TRANSPORT?.trim().toLowerCase();

  if (override === "console") {
    console.info("[mail] transport=console (MAIL_TRANSPORT=console) — nothing is sent");
    cached = consoleTransport;
  } else if (apiKey) {
    const from = process.env.MAIL_FROM?.trim();
    console.info(
      `[mail] transport=resend from=${from || "onboarding@resend.dev (DEFAULT)"}` +
        (from
          ? ""
          : " — the shared sender only delivers to the Resend account owner's address"),
    );
    cached = createResendTransport(apiKey);
  } else {
    if (override === "resend") {
      throw new Error("MAIL_TRANSPORT=resend but RESEND_API_KEY is not set");
    }
    console.warn(
      "[mail] transport=console because RESEND_API_KEY is missing — codes go to the " +
        "log, so nobody can sign in. Set RESEND_API_KEY (and MAIL_FROM).",
    );
    cached = consoleTransport;
  }

  return cached;
}

export async function sendOtpEmail(mail: OtpEmail): Promise<void> {
  await getTransport().sendOtp(mail);
}

/** Reports the configuration without sending anything. */
export function describeMailConfig() {
  return {
    transport: getTransport().name,
    hasApiKey: Boolean(process.env.RESEND_API_KEY?.trim()),
    from: process.env.MAIL_FROM?.trim() || "Skill Foundry <onboarding@resend.dev> (default)",
    override: process.env.MAIL_TRANSPORT?.trim() || null,
    deployed: Boolean(process.env.VERCEL_ENV),
    sampleSubject: otpSubject("sign-in"),
  };
}
