import "server-only";

import { objectUrl, r2Fetch } from "./client";
import {
  bundlePrefix,
  digestBundle,
  manifestKey,
  normalizeBundlePath,
  objectKey,
  sha256,
  type BundleDigest,
  type BundleFile,
  type StorageTier,
} from "./keys";

export {
  bundlePrefix,
  digestBundle,
  manifestKey,
  normalizeBundlePath,
  objectKey,
  sha256,
  type BundleDigest,
  type BundleFile,
  type StorageTier,
} from "./keys";
export { objectUrl } from "./client";

/**
 * Bundle storage, with the licence gate built in.
 *
 * The gate (Doc 2 R1.6, and the posture agreed with the owner): we always fetch, always
 * analyse, and always keep the hash, the verdicts and the metadata. Whether the *text* is
 * written here depends on what the licence permits. A skill we may not copy still gets a
 * verdict and still counts in corpus statistics — it simply has no bytes on our disk and
 * can never be quoted as an archetype exemplar.
 *
 * Callers cannot bypass this: `storeBundle` takes the posture and decides for itself.
 */

/** Mirrors the `redistribution_posture` enum in the schema. */
export type RedistributionPosture =
  | "mirror_allowed"
  | "attribution_required"
  | "metadata_only"
  | "unresolved";

/** Only these two permit copying. Unresolved is treated as "no" until proven otherwise. */
export function mayMirror(posture: RedistributionPosture): boolean {
  return posture === "mirror_allowed" || posture === "attribution_required";
}

export type StoreBundleInput = {
  files: BundleFile[];
  tier: StorageTier;
  redistribution: RedistributionPosture;
  /** Recorded in the manifest so the reason for a decision travels with the bundle. */
  licenseSpdx?: string | null;
};

export type StoreBundleResult = BundleDigest & {
  /** NULL when the licence forbade mirroring. */
  storageKey: string | null;
  contentStored: boolean;
  /** Set when nothing was written, so the caller can log why. */
  skippedReason?: string;
};

export type BundleManifest = {
  contentHash: string;
  tier: StorageTier;
  fileCount: number;
  byteSize: number;
  files: Record<string, string>;
  licenseSpdx: string | null;
  redistribution: RedistributionPosture;
  storedAt: string;
};

async function put(key: string, body: Buffer, contentType: string): Promise<void> {
  const response = await r2Fetch(objectUrl(key), {
    method: "PUT",
    body: new Uint8Array(body),
    headers: {
      "content-type": contentType,
      "content-length": String(body.byteLength),
    },
  });
  if (!response.ok) {
    throw new Error(`R2 PUT ${key} failed: ${response.status} ${await response.text()}`);
  }
}

/**
 * Hashes the bundle, then writes it only if the licence allows.
 *
 * Idempotent by construction: the key is derived from the content, so re-storing the same
 * bundle overwrites identical bytes at the same key. That is what makes an interrupted
 * sync safe to re-run.
 */
export async function storeBundle(input: StoreBundleInput): Promise<StoreBundleResult> {
  const digest = digestBundle(input.files);

  if (!mayMirror(input.redistribution)) {
    return {
      ...digest,
      storageKey: null,
      contentStored: false,
      skippedReason: `licence posture "${input.redistribution}" does not permit copying`,
    };
  }

  const manifest: BundleManifest = {
    contentHash: digest.contentHash,
    tier: input.tier,
    fileCount: digest.fileCount,
    byteSize: digest.byteSize,
    files: digest.fileHashes,
    licenseSpdx: input.licenseSpdx ?? null,
    redistribution: input.redistribution,
    storedAt: new Date().toISOString(),
  };

  for (const file of input.files) {
    const path = normalizeBundlePath(file.path);
    await put(objectKey(input.tier, digest.contentHash, path), file.content, guessType(path));
  }

  // Manifest last: its presence is the marker that the bundle is complete, so a crash
  // mid-upload leaves an obviously partial bundle rather than a silently truncated one.
  await put(
    manifestKey(input.tier, digest.contentHash),
    Buffer.from(JSON.stringify(manifest, null, 2)),
    "application/json",
  );

  return {
    ...digest,
    storageKey: bundlePrefix(input.tier, digest.contentHash),
    contentStored: true,
  };
}

/** Fetches one file and verifies it against the hash in the key's manifest. */
export async function getBundleFile(
  tier: StorageTier,
  contentHash: string,
  path: string,
): Promise<Buffer | null> {
  const key = objectKey(tier, contentHash, path);
  const response = await r2Fetch(objectUrl(key));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`R2 GET ${key} failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function getManifest(
  tier: StorageTier,
  contentHash: string,
): Promise<BundleManifest | null> {
  const response = await r2Fetch(objectUrl(manifestKey(tier, contentHash)));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`R2 GET manifest ${contentHash} failed: ${response.status}`);
  }
  return (await response.json()) as BundleManifest;
}

/**
 * Reads a bundle back and checks every file against its manifest hash.
 *
 * Used by the integrity path (Doc 2 R2.6): what a consumer exports must be bit-identical
 * to what was validated.
 */
export async function verifyBundle(
  tier: StorageTier,
  contentHash: string,
): Promise<{ ok: boolean; missing: string[]; mismatched: string[] }> {
  const manifest = await getManifest(tier, contentHash);
  if (!manifest) return { ok: false, missing: ["_manifest.json"], mismatched: [] };

  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const [path, expected] of Object.entries(manifest.files)) {
    const content = await getBundleFile(tier, contentHash, path);
    if (!content) {
      missing.push(path);
      continue;
    }
    if (sha256(content) !== expected) mismatched.push(path);
  }

  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

export async function deleteBundle(
  tier: StorageTier,
  contentHash: string,
): Promise<number> {
  const manifest = await getManifest(tier, contentHash);
  const paths = manifest ? Object.keys(manifest.files) : [];
  let deleted = 0;

  for (const key of [
    ...paths.map((path) => objectKey(tier, contentHash, path)),
    manifestKey(tier, contentHash),
  ]) {
    const response = await r2Fetch(objectUrl(key), { method: "DELETE" });
    if (response.ok || response.status === 404) deleted += 1;
  }
  return deleted;
}

function guessType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".py")) return "text/x-python; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".ts")) return "text/plain; charset=utf-8";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
