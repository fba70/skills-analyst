import "server-only";

import { createResendTransport } from "./resend";
import { otpSubject } from "./templates";
import type { MailTransport, OtpEmail, OtpPurpose } from "./types";

export type { MailTransport, OtpEmail, OtpPurpose };

/**
 * One interface, one transport chosen at runtime.
 *
 * Selection, in order:
 *   1. `MAIL_TRANSPORT=resend|console` — an explicit override, for testing delivery
 *      locally or silencing a deploy.
 *   2. a deployed environment (VERCEL_ENV is set) with RESEND_API_KEY — send for real.
 *   3. otherwise the console.
 *
 * Local development stays on the console by default even when the key is present, so
 * running the app on a laptop cannot quietly email people. A deploy *without* the key
 * falls back to the console and warns loudly, because a silent no-op there means nobody
 * can sign in while nothing looks broken.
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
  const isDeployed = Boolean(process.env.VERCEL_ENV);

  if (override === "console") {
    cached = consoleTransport;
  } else if (override === "resend" || (isDeployed && apiKey)) {
    if (!apiKey) {
      throw new Error("MAIL_TRANSPORT=resend but RESEND_API_KEY is not set");
    }
    cached = createResendTransport(apiKey);
  } else {
    if (isDeployed) {
      console.warn(
        "[mail] Deployed without RESEND_API_KEY — codes are going to the log, so " +
          "nobody can sign in. Set RESEND_API_KEY (and MAIL_FROM).",
      );
    }
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
