import "server-only";

import { AwsClient } from "aws4fetch";

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

export function objectUrl(key: string): string {
  const { endpoint, bucket } = r2Config();
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${endpoint}/${bucket}/${encoded}`;
}
