import "server-only";

import { githubConnector } from "@/server/connectors/github";
import { getBundleFile, getManifest, type BundleFile, type StorageTier } from "@/server/storage";

/**
 * Gets a bundle's bytes for analysis, from wherever they legitimately are.
 *
 * This is the piece that makes "analyse everything, mirror only what we may" actually
 * work. A `metadata_only` skill has no stored copy — so we re-fetch it from origin, in
 * memory, analyse it, and keep only the verdict. Its text never lands on our disk.
 *
 * Both paths are pinned to the same commit recorded in provenance, so a validation run is
 * reproducible and re-fetching cannot silently pick up different content than was hashed.
 */

export type VersionProvenance = {
  sourceUrl: string;
  path: string;
  commitSha: string;
  files: string[];
};

export type LoadedBundle = {
  files: BundleFile[];
  /** Where the bytes came from — recorded on the verdict for reproducibility. */
  origin: "storage" | "refetch";
};

export async function loadBundle(input: {
  contentStored: boolean;
  contentHash: string;
  tier: StorageTier;
  provenance: VersionProvenance;
}): Promise<LoadedBundle> {
  if (input.contentStored) {
    const manifest = await getManifest(input.tier, input.contentHash);
    if (manifest) {
      const files: BundleFile[] = [];
      for (const path of Object.keys(manifest.files)) {
        const content = await getBundleFile(input.tier, input.contentHash, path);
        if (content) files.push({ path, content });
      }
      if (files.length > 0) return { files, origin: "storage" };
    }
    // Falling through to a re-fetch is correct: a missing mirror is an availability
    // problem, not a reason to skip validating the skill.
  }

  const fetched = await githubConnector.fetch(
    { url: input.provenance.sourceUrl },
    {
      path: input.provenance.path,
      dialect: "anthropic_skill",
      commitSha: input.provenance.commitSha,
      files: input.provenance.files,
      licenseCandidates: [],
    },
  );

  return { files: fetched.files, origin: "refetch" };
}
