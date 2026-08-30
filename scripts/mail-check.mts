import "dotenv/config";

import { describeMailConfig, sendOtpEmail } from "../src/server/mail/index";

/**
 * Reports the mail configuration, and optionally sends one real message.
 *
 *   pnpm mail:check                      # report only, sends nothing
 *   pnpm mail:check --send you@you.com   # sends one real email
 *
 * Sending is behind an explicit flag and an explicit recipient on purpose: a script that
 * emails someone as a side effect of "checking config" is a script that will email the
 * wrong person eventually.
 */

const args = process.argv.slice(2);
const sendIndex = args.indexOf("--send");
const recipient = sendIndex >= 0 ? args[sendIndex + 1] : undefined;

const config = describeMailConfig();
console.info("\nMail configuration");
for (const [key, value] of Object.entries(config)) {
  console.info(`  ${key.padEnd(16)} ${value === null ? "—" : String(value)}`);
}

if (config.transport === "console") {
  console.info(
    "\n  Console transport: codes print to this terminal, nothing is emailed.\n" +
      "  Force a real send with MAIL_TRANSPORT=nylas.\n",
  );
}

if (!recipient) {
  console.info("  No --send <email> given, so nothing was sent.\n");
  process.exit(0);
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
  console.error(`\n  "${recipient}" is not an email address.\n`);
  process.exit(1);
}

console.info(`\n  Sending a test sign-in code to ${recipient} via ${config.transport}…`);
await sendOtpEmail({
  to: recipient,
  code: "123456",
  purpose: "sign-in",
  expiresInMinutes: 10,
});
console.info(
  "  Sent. If it does not arrive, search the Nylas dashboard for the request_id logged\n" +
    "  above — a 200 means Nylas accepted the message, not that the provider delivered it.\n",
);
