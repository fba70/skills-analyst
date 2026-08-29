import "dotenv/config";

/**
 * Proves the storage layer against the real bucket: hashing is deterministic, the licence
 * gate actually withholds bytes, round-trips verify, and nothing is left behind.
 *
 *   pnpm storage:verify
 */

// Run with `--conditions=react-server`: that is the export condition `server-only`
// resolves to an empty module under, which is exactly the guarantee we want — the script
// is server code, so the guard should be satisfied rather than bypassed.
import * as storage from "../src/server/storage/index";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) =>
  checks.push({ name, ok, detail });

const files = [
  { path: "SKILL.md", content: Buffer.from("---\nname: fixture\n---\n# Fixture\n") },
  { path: "scripts/run.py", content: Buffer.from("print('hello')\n") },
  { path: "references/notes.md", content: Buffer.from("Some reference text.\n") },
];

// 1. Hashing is order-independent and path-normalised.
const a = storage.digestBundle(files);
const b = storage.digestBundle([files[2], files[0], files[1]]);
const c = storage.digestBundle([
  { path: "./SKILL.md", content: files[0].content },
  { path: "scripts//run.py", content: files[1].content },
  { path: "references/notes.md", content: files[2].content },
]);
record(
  "bundle hash is order-independent",
  a.contentHash === b.contentHash,
  a.contentHash.slice(0, 16),
);
record("bundle hash is path-normalised", a.contentHash === c.contentHash, "./ and // ignored");

// 2. Different content means a different key.
const changed = storage.digestBundle([
  { path: "SKILL.md", content: Buffer.from("---\nname: fixture\n---\n# Changed\n") },
  files[1],
  files[2],
]);
record(
  "one changed byte changes the hash",
  changed.contentHash !== a.contentHash,
  changed.contentHash.slice(0, 16),
);

// 3. Path traversal is refused.
let traversalBlocked = false;
try {
  storage.digestBundle([{ path: "../escape.md", content: Buffer.from("x") }]);
} catch {
  traversalBlocked = true;
}
record("path traversal refused", traversalBlocked, "../escape.md rejected");

// 4. The licence gate withholds bytes but keeps the hash.
for (const posture of ["metadata_only", "unresolved"] as const) {
  const result = await storage.storeBundle({
    files,
    tier: "public",
    redistribution: posture,
  });
  record(
    `licence "${posture}" stores no bytes`,
    result.contentStored === false &&
      result.storageKey === null &&
      result.contentHash === a.contentHash,
    `hash kept, ${result.skippedReason}`,
  );
}

// 5. A permitted licence round-trips and verifies.
const stored = await storage.storeBundle({
  files,
  tier: "quarantine",
  redistribution: "mirror_allowed",
  licenseSpdx: "MIT",
});
record(
  "licence \"mirror_allowed\" writes the bundle",
  stored.contentStored && stored.storageKey !== null,
  stored.storageKey ?? "",
);

const verified = await storage.verifyBundle("quarantine", stored.contentHash);
record(
  "every file verifies against its manifest hash",
  verified.ok,
  `missing ${verified.missing.length}, mismatched ${verified.mismatched.length}`,
);

const roundTripped = await storage.getBundleFile("quarantine", stored.contentHash, "SKILL.md");
record(
  "file content round-trips byte-for-byte",
  roundTripped !== null && roundTripped.equals(files[0].content),
  `${roundTripped?.byteLength ?? 0} bytes`,
);

const manifest = await storage.getManifest("quarantine", stored.contentHash);
record(
  "manifest records the licence decision",
  manifest?.licenseSpdx === "MIT" && manifest?.redistribution === "mirror_allowed",
  `${manifest?.licenseSpdx} / ${manifest?.redistribution}`,
);

// 6. Re-storing identical content is idempotent (same key, no duplicate).
const again = await storage.storeBundle({
  files,
  tier: "quarantine",
  redistribution: "mirror_allowed",
  licenseSpdx: "MIT",
});
record(
  "re-storing the same bundle is idempotent",
  again.storageKey === stored.storageKey,
  again.storageKey ?? "",
);

// 7. Clean up.
const deleted = await storage.deleteBundle("quarantine", stored.contentHash);
const afterDelete = await storage.getManifest("quarantine", stored.contentHash);
record("test bundle removed", afterDelete === null, `${deleted} objects deleted`);

for (const check of checks) {
  console.info(`${check.ok ? "PASS" : "FAIL"}  ${check.name}\n      ${check.detail}`);
}
if (checks.some((check) => !check.ok)) process.exit(1);
console.info("\nStorage layer verified against the real bucket.\n");
