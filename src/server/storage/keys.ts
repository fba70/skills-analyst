import "server-only";

import { createHash } from "node:crypto";

/**
 * Content addressing.
 *
 * The key *is* the hash the verdict covers, so integrity is structural rather than
 * checked: you cannot fetch bytes that differ from what was validated, because different
 * bytes live at a different key. Keys are never reused, which also makes CDN caching safe
 * if we ever serve them.
 */

/** Trust level, expressed as a key prefix. See the storage rule in CLAUDE.md. */
export type StorageTier = "public" | "quarantine" | "drafts";

export type BundleFile = {
  /** POSIX-style path inside the bundle, e.g. "SKILL.md" or "scripts/run.py". */
  path: string;
  content: Buffer;
};

export type BundleDigest = {
  /** sha256 over the whole bundle: paths and contents, order-independent. */
  contentHash: string;
  /** sha256 per file, kept for per-file integrity and the provenance record. */
  fileHashes: Record<string, string>;
  byteSize: number;
  fileCount: number;
};

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalises a path so the same bundle always hashes the same: forward slashes, no
 * leading "./" or "/", no "..".
 */
export function normalizeBundlePath(path: string): string {
  const cleaned = path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

  if (cleaned.split("/").includes("..")) {
    throw new Error(`Refusing path that escapes the bundle: ${path}`);
  }
  if (cleaned.length === 0) {
    throw new Error("Bundle path is empty");
  }
  return cleaned;
}

/**
 * Hashes a bundle deterministically.
 *
 * The digest covers `path\0sha256(content)\n` per file, sorted by path — so re-fetching
 * the same skill in a different file order produces the same hash, and dedup across
 * sources actually collapses (Doc 2 R1.4). A rename changes the hash, which is correct:
 * it is a different bundle.
 */
export function digestBundle(files: BundleFile[]): BundleDigest {
  if (files.length === 0) {
    throw new Error("Cannot hash an empty bundle");
  }

  const fileHashes: Record<string, string> = {};
  let byteSize = 0;

  for (const file of files) {
    const path = normalizeBundlePath(file.path);
    if (path in fileHashes) {
      throw new Error(`Duplicate path in bundle: ${path}`);
    }
    fileHashes[path] = sha256(file.content);
    byteSize += file.content.byteLength;
  }

  const manifest = Object.keys(fileHashes)
    .sort()
    .map((path) => `${path}\0${fileHashes[path]}\n`)
    .join("");

  return {
    contentHash: sha256(manifest),
    fileHashes,
    byteSize,
    fileCount: Object.keys(fileHashes).length,
  };
}

/** `public/sha256/<hash>/SKILL.md` */
export function objectKey(tier: StorageTier, contentHash: string, path: string): string {
  return `${tier}/sha256/${contentHash}/${normalizeBundlePath(path)}`;
}

/** Every bundle carries a manifest, so its file list is readable without a LIST call. */
export function manifestKey(tier: StorageTier, contentHash: string): string {
  return `${tier}/sha256/${contentHash}/_manifest.json`;
}

export function bundlePrefix(tier: StorageTier, contentHash: string): string {
  return `${tier}/sha256/${contentHash}/`;
}
