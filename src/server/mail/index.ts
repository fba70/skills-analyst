import "server-only";

/**
 * One interface, one transport at a time.
 *
 * Local development prints the code to the terminal, so nobody needs a mail account
 * to log in. To go live, add a `resend.ts` transport next to this file and pick it in
 * `getTransport()` — nothing else in the app changes.
 */

export type OtpPurpose =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

export type OtpEmail = {
  to: string;
  code: string;
  purpose: OtpPurpose;
};

export type MailTransport = {
  sendOtp(mail: OtpEmail): Promise<void>;
};

const purposeLabel: Record<OtpPurpose, string> = {
  "sign-in": "Sign in",
  "email-verification": "Verify your email",
  "forget-password": "Reset your password",
  "change-email": "Confirm your new email",
};

const consoleTransport: MailTransport = {
  async sendOtp({ to, code, purpose }) {
    const label = purposeLabel[purpose];
    const width = 46;
    const line = "─".repeat(width);
    const row = (text: string) => `│ ${text.padEnd(width - 2)} │`;
    // Deliberately a console write: this IS the dev mail transport.
    console.info(
      [
        "",
        `┌${line}┐`,
        row(`Skill Foundry — ${label}`),
        row(`to:   ${to}`),
        row(`code: ${code}`),
        `└${line}┘`,
        "",
      ].join("\n"),
    );
  },
};

function getTransport(): MailTransport {
  return consoleTransport;
}

export async function sendOtpEmail(mail: OtpEmail): Promise<void> {
  await getTransport().sendOtp(mail);
}
