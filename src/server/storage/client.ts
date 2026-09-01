import "server-only";

import { AwsClient } from "aws4fetch";

import { REQUEST_TIMEOUT_MS } from "@/server/http/deadline";

/**
 * R2 over the S3 API.
 *
 * `aws4fetch` rather than the AWS SDK: we need four verbs, and a 4 KB fetch-based signer
 * keeps the function bundle small and runs unchanged on any runtime — which matters
 * because the sandbox runner in Doc 3's Phase 4 lands on Cloudflare, not Node.
 */

export type R2Config = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function readConfig(): R2Config {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  const missing = Object.entries({
    R2_ENDPOINT: endpoint,
    R2_BUCKET_NAME: bucket,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`R2 is not configured: ${missing.join(", ")}`);
  }

  return {
    endpoint: endpoint!.replace(/\/+$/, ""),
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
  };
}

const globalForR2 = globalThis as unknown as {
  r2Client?: AwsClient;
  r2Config?: R2Config;
};

export function r2Config(): R2Config {
  globalForR2.r2Config ??= readConfig();
  return globalForR2.r2Config;
}

export function r2Client(): AwsClient {
  if (!globalForR2.r2Client) {
    const config = r2Config();
    globalForR2.r2Client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      // R2 ignores the region but SigV4 requires one in the credential scope.
      region: "auto",
      service: "s3",
    });
  }
  return globalForR2.r2Client;
}

/**
 * Every R2 request, with a deadline.
 *
 * ## Why this exists separately from `fetchWithDeadline`
 *
 * `aws4fetch` exposes `fetch` as a **method** — `r2Client().fetch(url, init)` — so it is
 * invisible to a search for bare `fetch(` calls. That is not a hypothetical gap: two
 * ingestion runs hung on an R2 socket, and the first fix guarded every GitHub call while
 * leaving these four untouched, because the grep that found the others could not see them.
 * The stalled peer both times was `141.101.90.96/.97`, which is exactly what this bucket's
 * endpoint resolves to.
 *
 * ## The signal has to survive signing
 *
 * `AwsClient.fetch` calls `sign()`, which builds a new `Request`, and only then hands it to
 * global `fetch`. Whether an `AbortSignal` passed in `init` survives that round trip is a
 * property of a dependency, not something to assume — `verify:http-deadline` asserts it
 * against a server that never answers, so an upgrade that breaks the propagation turns a
 * check red instead of turning the pipeline into a process that waits for ever.
 */
export async function r2Fetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await r2Client().fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (!aborted) throw error;
    // Named, like the HTTP helper: "aborted" alone reads as our bug rather than a dead peer.
    throw new Error(`R2 timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`, { cause: error });
  }
}

export function objectUrl(key: string): string {
  const { endpoint, bucket } = r2Config();
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint}/${bucket}/${encoded}`;
}
