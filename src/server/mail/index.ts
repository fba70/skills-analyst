import "server-only";

import { createNylasTransport, readNylasConfig } from "./nylas";
import { otpSubject } from "./templates";
import type { MailTransport, OtpEmail, OtpPurpose } from "./types";

export type { MailTransport, OtpEmail, OtpPurpose };

/**
 * One interface, one transport chosen at runtime.
 *
 * Selection, in order:
 *   1. `MAIL_TRANSPORT=console` — never send, print instead.
 *   2. `NYLAS_API_KEY` and `NYLAS_GRANT_ID` both present — send for real.
 *   3. otherwise the console, with a warning.
 *
 * Note what this deliberately does NOT depend on: `VERCEL_ENV`. An earlier version keyed
 * "should we really send?" off that variable, which is a system variable a project can be
 * configured not to expose — and if it is missing, mail silently downgrades to the console
 * and nobody can sign in. Presence of the credentials is the honest signal. Local
 * development pins `MAIL_TRANSPORT=console` in .env instead, so a laptop still cannot
 * quietly email people.
 *
 * **Both Nylas variables are required together**, and a half-configured deployment is
 * treated as unconfigured rather than as an error at send time. A grant id without a key
 * is not a working sender, and discovering that when the first user tries to sign in is
 * the failure this ordering exists to avoid.
 *
 * The chosen transport is logged once, because "which transport is this deployment using"
 * is the first question when mail does not arrive.
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

  const override = process.env.MAIL_TRANSPORT?.trim().toLowerCase();
  const nylas = readNylasConfig();

  if (override === "console") {
    console.info("[mail] transport=console (MAIL_TRANSPORT=console) — nothing is sent");
    cached = consoleTransport;
  } else if (nylas) {
    const from = process.env.MAIL_FROM?.trim();
    console.info(
      `[mail] transport=nylas uri=${nylas.apiUri} grant=${nylas.grantId.slice(0, 8)}… ` +
        // The grant *is* the sender, so its mailbox is what the recipient sees when
        // MAIL_FROM is unset. Saying "grant mailbox" rather than printing nothing keeps
        // the log honest about where mail comes from.
        `from=${from || "(grant mailbox)"}`,
    );
    cached = createNylasTransport(nylas);
  } else {
    if (override === "nylas") {
      throw new Error(
        "MAIL_TRANSPORT=nylas but NYLAS_API_KEY and NYLAS_GRANT_ID are not both set",
      );
    }
    console.warn(
      "[mail] transport=console because NYLAS_API_KEY / NYLAS_GRANT_ID are missing — " +
        "codes go to the log, so nobody can sign in.",
    );
    cached = consoleTransport;
  }

  return cached;
}

export async function sendOtpEmail(mail: OtpEmail): Promise<void> {
  await getTransport().sendOtp(mail);
}

/** Reports the configuration without sending anything. Never returns a secret. */
export function describeMailConfig() {
  const nylas = readNylasConfig();
  return {
    transport: getTransport().name,
    hasApiKey: Boolean(process.env.NYLAS_API_KEY?.trim()),
    // The grant id is not a credential, but it is an account identifier, so only enough of
    // it is shown to tell two grants apart in a log.
    grant: nylas ? `${nylas.grantId.slice(0, 8)}…` : null,
    apiUri: nylas?.apiUri ?? null,
    from: process.env.MAIL_FROM?.trim() || "(grant mailbox)",
    override: process.env.MAIL_TRANSPORT?.trim() || null,
    deployed: Boolean(process.env.VERCEL_ENV),
    sampleSubject: otpSubject("sign-in"),
  };
}
