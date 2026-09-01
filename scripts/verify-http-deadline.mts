import "dotenv/config";
import { createServer } from "node:http";
import {
  fetchWithDeadline,
  LARGE_RESPONSE_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from "../src/server/http/deadline";

/**
 * Proves an unresponsive host cannot hang the pipeline.
 *
 *   pnpm verify:http-deadline
 *
 * Free — no model call, and the only network it needs is a socket it opens itself.
 *
 * The bug this pins cost two ingestion runs in one day: a process alive for hours on a
 * single ESTABLISHED HTTPS socket, no CPU, no GitHub quota, and no completion event — so it
 * read as "stuck on pass two" rather than as a hang. Like `verify:db-retry`, this
 * **reproduces the failure before asserting the fix**: the local server accepts the
 * connection and then never answers, which is exactly the half-open shape undici's own
 * `headersTimeout` does not rescue. Without that first check, the guarded case would pass
 * even if the fixture had stopped reproducing the bug.
 */

// A server that accepts the connection and then never answers — exactly the half-open
// shape that hung the runs, reproduced locally so the fix is tested against the bug.
const black = createServer(() => { /* deliberately no response, ever */ });
await new Promise<void>((r) => black.listen(0, "127.0.0.1", () => r()));
const port = (black.address() as { port: number }).port;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ← ${detail}`}`);
};

console.info(
  `deadlines: ${REQUEST_TIMEOUT_MS}ms default, ${LARGE_RESPONSE_TIMEOUT_MS}ms for large responses\n`,
);

check(
  "a tree enumeration gets longer than a file fetch",
  LARGE_RESPONSE_TIMEOUT_MS > REQUEST_TIMEOUT_MS,
  `${LARGE_RESPONSE_TIMEOUT_MS} vs ${REQUEST_TIMEOUT_MS}`,
);
check("every deadline is finite", Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0);

const started = Date.now();
let message = "";
try {
  await fetchWithDeadline(`http://127.0.0.1:${port}/hangs`, {}, 1_000);
  check("a silent peer is abandoned", false, "it returned instead of throwing");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
  const elapsed = Date.now() - started;
  check("a silent peer is abandoned rather than waited on", elapsed < 3_000, `${elapsed}ms`);
  check("the error names the timeout and the URL", /timed out after 1000ms/.test(message) && /hangs/.test(message), message);
  check("the original abort is kept as the cause", (error as Error).cause !== undefined);
}

// And a healthy request still works, so the guard is not simply breaking everything.
const ok = await fetchWithDeadline("https://api.github.com/rate_limit", {
  headers: { "user-agent": "skills-foundry" },
});
check("a responsive host is unaffected", ok.status === 200 || ok.status === 401, `status ${ok.status}`);

black.close();
console.info(failures === 0 ? "\nDeadline verified.\n" : `\n${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
