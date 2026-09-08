import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/**
 * The committed tree builds (repo hygiene).
 *
 *   pnpm verify:tree
 *
 * Free, offline, and needs no database. It reads git's index and the files on disk, nothing else.
 *
 * ## Why this exists
 *
 * Because "the tree does not match reality" has now cost two deploys in different disguises, and
 * both were invisible locally — a working copy has every file whether or not git knows about it,
 * so `pnpm build` passes on the machine that wrote the code and fails on the machine that clones
 * it.
 *
 *   1. **Migration 0031 was applied and then its files removed**, leaving a database ahead of a
 *      tree that could never reproduce it. `pnpm db:audit` caught that one by counting applied
 *      against on-disk.
 *   2. **Commit `09cf61f` staged every modified file and no new one** — the signature of
 *      `git add -u` — so `page.tsx` imported a `matrix-panel` that was not in the commit and the
 *      production build failed on a module the author had open in their editor.
 *
 * Nothing in the existing suites could see either. `typecheck`, `lint` and `build` all read the
 * working copy; this is the only check that reads what would actually be shipped.
 *
 * ## What it asserts
 *
 * - every `@/…` and relative import in a **tracked** source file resolves to a **tracked** file
 * - every migration named in the journal has its `.sql` committed, and the newest snapshot with it
 * - every `verify:*` script in `package.json` points at a tracked file
 *
 * Each failure says whether the target is **on disk but never added**, because that distinguishes
 * the two ways this goes wrong: a file nobody staged (fix: stage it) and a file nobody wrote
 * (fix: write it). Guessing between those is most of the time lost to a red build.
 *
 * All three are the same question — *would a fresh clone have this?* — asked of the three places
 * this repo has needed it.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Everything git would give a fresh clone. */
const tracked = new Set(
  execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

const sourceFiles = [...tracked].filter((path) => /^(src|scripts)\/.*\.(ts|tsx|mts)$/.test(path));

// ---------------------------------------------------------------------------------------
console.info("\nEvery import a fresh clone would have to resolve");
// ---------------------------------------------------------------------------------------

/**
 * Resolve the way the bundler does: exact file, then extensions, then a directory index.
 *
 * Deliberately generous — a false negative here is a build failure somebody else discovers, and a
 * false positive is one line of output. When in doubt the candidate list grows rather than the
 * check getting stricter.
 */
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", "/index.ts", "/index.tsx"];

function resolvesTracked(base: string): boolean {
  return EXTENSIONS.some((extension) => tracked.has(normalize(base + extension)));
}

/** On disk but not in the index — which is exactly the failure being hunted. */
function existsUntracked(base: string): boolean {
  return EXTENSIONS.some((extension) => existsSync(normalize(base + extension)));
}

const missing: Array<{ from: string; specifier: string; onDisk: boolean }> = [];

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  /*
   * Static `import`/`export … from` and dynamic `import(…)` alike. The bug that prompted this
   * hid in a **dynamic** import inside a server action, which is the form a grep for `^import`
   * would never have seen — the `aws4fetch` lesson, one layer up.
   */
  const specifiers = [
    /*
     * `[^"'\n]` — a module specifier never spans a line, and without that bound the first
     * version matched from an apostrophe in one doc comment to a quote several paragraphs later
     * and reported a page of prose as an unresolved import. A regex that can match the wrong
     * thing reports the wrong thing confidently.
     */
    ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g),
  ].map((match) => match[1]);

  for (const specifier of specifiers) {
    let base: string | null = null;
    if (specifier.startsWith("@/")) base = join("src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = join(dirname(file), specifier);
    if (!base) continue; // a package, not ours

    base = relative(process.cwd(), join(process.cwd(), base));
    if (resolvesTracked(base)) continue;
    missing.push({ from: file, specifier, onDisk: existsUntracked(base) });
  }
}

check(
  "every import in a tracked file resolves to a tracked file",
  missing.length === 0,
  missing.length === 0
    ? `${sourceFiles.length} files scanned`
    : missing
        .map((m) => `${m.specifier} (from ${m.from})${m.onDisk ? " — on disk, never added" : ""}`)
        .join("; "),
);

/*
 * The check has to be able to see its own subject. A scan that matched no imports at all would
 * pass trivially — the shape `verify:blocks` shipped when it went green on an empty table.
 */
check(
  "and the scan actually found imports to resolve",
  sourceFiles.length > 50,
  `${sourceFiles.length} tracked source files`,
);

// ---------------------------------------------------------------------------------------
console.info("\nEvery migration the journal claims");
// ---------------------------------------------------------------------------------------

/**
 * The journal is a tracked file listing migrations by tag. A committed journal entry whose `.sql`
 * is missing is a tree that can never reach the schema it says it has — the state migration 0031
 * left the repo in, from the other direction.
 */
{
  const journal = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };

  const missingSql = journal.entries.filter((entry) => !tracked.has(`migrations/${entry.tag}.sql`));
  check(
    "every migration named in the journal has its SQL committed",
    missingSql.length === 0,
    missingSql.length === 0
      ? `${journal.entries.length} migrations`
      : missingSql.map((e) => e.tag).join(", "),
  );

  /**
   * The **latest** snapshot, and only that one.
   *
   * `db:generate` diffs the schema against the newest snapshot, so a fresh clone missing it emits
   * a migration recreating every object that already exists. Intermediate snapshots are drizzle's
   * own history and a gap in them changes nothing anybody can act on — `0023` has been missing
   * one since it was written, and asserting on it would put a permanently red line in a suite,
   * which is how an alarm stops being read.
   */
  const latest = journal.entries[journal.entries.length - 1];
  const latestSnapshot = `migrations/meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`;
  check(
    "and the newest drizzle snapshot, which the next generate diffs against",
    tracked.has(latestSnapshot),
    latest.tag,
  );

  const historicalGaps = journal.entries.filter(
    (entry) => !tracked.has(`migrations/meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`),
  );
  if (historicalGaps.length > 0) {
    console.info(
      `  note  ${historicalGaps.length} older snapshot(s) absent (${historicalGaps
        .map((e) => e.tag)
        .join(", ")}) — drizzle history, not something a clone needs`,
    );
  }
}

// ---------------------------------------------------------------------------------------
console.info("\nEvery script package.json advertises");
// ---------------------------------------------------------------------------------------

{
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  const broken = Object.entries(pkg.scripts)
    .map(([name, command]) => ({ name, path: command.match(/(scripts\/[\w.-]+\.m?ts)/)?.[1] }))
    .filter((entry): entry is { name: string; path: string } => Boolean(entry.path))
    .filter((entry) => !tracked.has(entry.path));

  check(
    "every script command points at a committed file",
    broken.length === 0,
    broken.length === 0 ? "" : broken.map((b) => `${b.name} → ${b.path}`).join(", "),
  );
}

console.info(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
