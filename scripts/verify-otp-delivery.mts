import "dotenv/config";

/**
 * Proves a failed OTP send cannot be reported as success.
 *
 *   pnpm verify:otp
 *
 * The bug this pins is not ours and cannot be fixed where it happens. Better Auth passes
 * our transport to `runInBackgroundOrAwait`, which awaits it and then catches — so a send
 * that throws still produces a 200, and the sign-in form used to advance to the code step
 * and say "Code sent" to someone who would wait for ever.
 *
 * Four properties, in the order they matter:
 *
 *   1. Better Auth really does swallow the throw. This is the external behaviour the whole
 *      design works around; if an upgrade ever changes it, this check turns red and the
 *      workaround can be deleted rather than quietly kept for years.
 *   2. The failure survives that swallow, so the action can read it back.
 *   3. It is read exactly once — a failure must not haunt the next attempt.
 *   4. A failure recorded *before* an attempt started is never attributed to it. That is
 *      the `since` guarantee, and without it a stale error would report a problem on an
 *      attempt that actually succeeded.
 *
 * The transport is pointed at a deliberately invalid Nylas key, so the only outbound call
 * is one that is meant to be refused. Nothing is emailed and no user is created — the
 * endpoint writes a verification row, which is cleaned up at the end.
 */

// Set before the mail module is imported: `getTransport()` caches its choice on first use,
// so the environment has to be wrong *before* anything reads it. This is also why every
// import below is dynamic.
process.env.MAIL_TRANSPORT = "nylas";
process.env.NYLAS_API_KEY = "verify-otp-invalid-key";
process.env.NYLAS_GRANT_ID = process.env.NYLAS_GRANT_ID || "00000000-0000-0000-0000-000000000000";

const { auth } = await import("../src/server/auth/index");
const { recordSendFailure, takeSendFailure } = await import(
  "../src/server/auth/send-failures"
);
const { db } = await import("../src/server/db");
const { verification } = await import("../src/server/db/schema/auth");
const { like } = await import("drizzle-orm");

const address = `verify-otp-${Date.now()}@example.invalid`;
let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
}

// --- Properties 1 and 2: the throw is swallowed, the reason survives ----------
{
  const startedAt = Date.now();
  let threw: string | null = null;

  try {
    await auth.api.sendVerificationOTP({ body: { email: address, type: "sign-in" } });
  } catch (error) {
    threw = (error as Error).message;
  }

  check(
    "Better Auth swallows a transport throw and answers success",
    threw === null,
    `it threw instead: ${threw} — if this is an upgrade, the workaround can go`,
  );

  const recorded = takeSendFailure(address, startedAt);
  check(
    "the send failure is recoverable after the swallow",
    recorded !== null && /nylas/i.test(recorded),
    `takeSendFailure returned ${recorded === null ? "null" : `"${recorded}"`}`,
  );
}

// --- Property 3: read once, never twice --------------------------------------
{
  const again = takeSendFailure(address, 0);
  check(
    "a failure is consumed by the first read",
    again === null,
    `a second read returned "${again}"`,
  );
}

// --- Property 4: a failure cannot be attributed to a later attempt ------------
{
  recordSendFailure(address, "an older failure");
  // A caller that started *after* the failure was recorded must not see it.
  const since = Date.now() + 1_000;
  const leaked = takeSendFailure(address, since);
  check(
    "a failure older than the attempt is not reported against it",
    leaked === null,
    `a stale failure leaked: "${leaked}"`,
  );
}

// Cleanup: the endpoint stored a verification row for the fixture address.
await db.delete(verification).where(like(verification.identifier, `%${address}%`));

console.info(
  failures === 0 ? "\nOTP delivery reporting verified.\n" : `\n${failures} failure(s)\n`,
);
process.exit(failures > 0 ? 1 : 0);
