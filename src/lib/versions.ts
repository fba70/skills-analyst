/**
 * Things a skill pins a version of, and where each announces releases (Doc 7 RD.10, step P5).
 *
 * RK.2 promised *"your skill teaches Next 15 idioms; 16 changed X"* and shipped without it —
 * link rot and review dates landed, version drift did not, because nothing knew which tool a
 * skill referenced. P0 made that measurable and P5 is the half that was missing.
 *
 * ## Written from the count, and the count is what makes it small
 *
 * Extractor 2.1.0 stored **7,023 documents carrying at least one pin**, and reading the table
 * by distinct repository decided this list. The head is `python` 118, `node` 109, `next` 57,
 * `go` 27, `swift` 21, `typescript` 15, `php` 14, `react` 13, `terraform` 12, `powershell` 11,
 * `java` 9. Everything above those in raw frequency is noise from a regex over prose — `if`
 * (90 repos), `is` (62), `rate` (50), `count`, `ratio`, `target`, `has` — and the fix is the
 * one P1 used for tools: **a closed vocabulary applied at read time**, not a cleverer regex
 * and not a re-extract. `skill_structures.version_pins` keeps every candidate, exactly as
 * `tool_refs` keeps every token, so widening this list costs a query.
 *
 * ## The version half of the detector turned out to be good
 *
 * Worth recording because the aggregate suggested otherwise. Filtered to one name, the pins
 * are overwhelmingly real: `python` reads 3, 3.10, 3.8, 3.11, 3.9, 3.12; `node` reads 18, 20,
 * 22, 16, 24; `go` reads 1.21, 1.24, 1.22, 1.26. The junk values are a long tail under names
 * that were never tools. So the noise was entirely in the *name* half, which is precisely what
 * a vocabulary fixes.
 *
 * ## What is deliberately not tracked
 *
 * - **Models** — `opus` (36 repos), `sonnet` (31), `gemini` (34), `claude`, `haiku`. Real
 *   pins, no machine-readable release feed, and a model id is already a *setting* here
 *   (`src/lib/models.ts`) rather than something a skill should be nagged about.
 * - **Standards** — `wcag` (64), `oauth` (55), `tls` (28), `openapi` (25), `cvss`, `cfr`.
 *   These are the most-pinned names after the runtimes and they are the clearest exclusion:
 *   **a standard version is a choice, not staleness.** A skill written against WCAG 2.1 does
 *   not become wrong when 2.2 ships, and telling its author otherwise would be the alarm
 *   nobody can silence, on a page they cannot act on.
 *
 * A leaf module with no imports, like `tools.ts` beside it.
 */

export type VersionedThing = {
  /** Stable id, and the value stored in `tool_versions.subject`. */
  id: string;
  label: string;
  /** Other spellings the pin detector produces for the same thing. Folded, like a repo name. */
  aliases?: readonly string[];
  /**
   * Where it announces releases.
   *
   * `github` is a repository whose **latest release** is the answer. `eol` is
   * endoflife.date's product feed, for the projects GitHub cannot answer for.
   *
   * **Every entry below was fetched before it was written down.** `seeds.ts` is why that is a
   * rule rather than a habit — three of its hand-written entries were 404s — and it earned its
   * place again here: the first draft of this list put `python`, `go`, `django` and `postgres`
   * on GitHub releases and **all four 404'd**, because those projects tag rather than release.
   * Tags are no substitute and were checked too: `python/cpython` returns release candidates
   * first (`v3.15.0rc2` while 3.14 is stable), and `golang/go` returns **weekly tags from
   * 2012**. A feed written from memory would have claimed a version nobody shipped.
   */
  releases:
    | { kind: "github"; repo: string }
    | { kind: "eol"; product: string };
  /**
   * How much of a version number is worth comparing.
   *
   * `major` for things that version by a single number a skill would pin (`node 18`,
   * `next 15`); `minor` where the meaningful unit is `x.y` (`python 3.11`, `go 1.21`). Beyond
   * that is patch noise: nobody writing a skill against Python 3.11 means 3.11.4, and
   * reporting drift on a patch release would fire on every document every month.
   */
  precision: "major" | "minor";
};

export const VERSIONED: readonly VersionedThing[] = [
  /*
   * Two feeds, because one cannot answer for everything, and the split is not arbitrary:
   * every `eol` entry is a project that publishes git tags rather than GitHub releases.
   * endoflife.date agrees with GitHub where both answer — `node` reads 26.8.2 from each —
   * which is the cross-check that makes trusting the second source reasonable.
   */
  { id: "python", label: "Python", releases: { kind: "eol", product: "python" }, precision: "minor" }, // 118 repos
  { id: "node", label: "Node.js", aliases: ["nodejs"], releases: { kind: "github", repo: "nodejs/node" }, precision: "major" }, // 109
  { id: "next", label: "Next.js", aliases: ["nextjs"], releases: { kind: "github", repo: "vercel/next.js" }, precision: "major" }, // 57
  { id: "go", label: "Go", aliases: ["golang"], releases: { kind: "eol", product: "go" }, precision: "minor" }, // 27
  { id: "swift", label: "Swift", releases: { kind: "github", repo: "swiftlang/swift" }, precision: "major" }, // 21
  { id: "typescript", label: "TypeScript", aliases: ["ts"], releases: { kind: "github", repo: "microsoft/TypeScript" }, precision: "minor" }, // 15
  { id: "php", label: "PHP", releases: { kind: "github", repo: "php/php-src" }, precision: "minor" }, // 14
  { id: "react", label: "React", releases: { kind: "github", repo: "facebook/react" }, precision: "major" }, // 13
  { id: "terraform", label: "Terraform", releases: { kind: "github", repo: "hashicorp/terraform" }, precision: "minor" }, // 12
  { id: "powershell", label: "PowerShell", aliases: ["pwsh"], releases: { kind: "github", repo: "PowerShell/PowerShell" }, precision: "major" }, // 11
  { id: "kubectl", label: "Kubernetes", aliases: ["kubernetes", "k8s"], releases: { kind: "github", repo: "kubernetes/kubernetes" }, precision: "minor" }, // 7 + 3
  { id: "rust", label: "Rust", aliases: ["cargo"], releases: { kind: "github", repo: "rust-lang/rust" }, precision: "minor" }, // 7 + 1
  { id: "vue", label: "Vue", releases: { kind: "github", repo: "vuejs/core" }, precision: "major" }, // 7
  { id: "bun", label: "Bun", releases: { kind: "github", repo: "oven-sh/bun" }, precision: "minor" }, // 7
  { id: "django", label: "Django", releases: { kind: "eol", product: "django" }, precision: "minor" }, // 2
  { id: "rails", label: "Rails", releases: { kind: "github", repo: "rails/rails" }, precision: "major" }, // 2
  { id: "tailwind", label: "Tailwind CSS", aliases: ["tailwindcss"], releases: { kind: "github", repo: "tailwindlabs/tailwindcss" }, precision: "major" }, // 2
  { id: "kotlin", label: "Kotlin", releases: { kind: "github", repo: "JetBrains/kotlin" }, precision: "minor" }, // 2
  { id: "deno", label: "Deno", releases: { kind: "github", repo: "denoland/deno" }, precision: "major" }, // 1
];

/*
 * Two names the corpus pins that are deliberately **not** here, both for reasons worth keeping.
 *
 * `java` (9 repos) has no feed this can read: `openjdk/jdk` publishes no GitHub releases, its
 * tags are early-access builds (`jdk-28+15`) rather than the shipped LTS, and endoflife.date
 * has no `java` product. Claiming a current Java version from any of those would be inventing
 * one, so nothing is claimed and no drift is reported for it.
 *
 * `postgres` is pinned by **no skill at all** — it was in an earlier draft of this list from
 * memory rather than from the table, which is the exact failure the list exists to avoid.
 * `verify:version-drift` asserts every entry is pinned somewhere, so a speculative addition
 * fails rather than sits.
 */

export const VERSIONED_IDS: readonly string[] = VERSIONED.map((v) => v.id);

const BY_NAME = new Map<string, string>();
for (const thing of VERSIONED) {
  BY_NAME.set(thing.id.toLowerCase(), thing.id);
  for (const alias of thing.aliases ?? []) BY_NAME.set(alias.toLowerCase(), thing.id);
}

/** A pinned name, resolved to something we track, or null — which is the common answer. */
export function resolveVersioned(name: string): string | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function versionedById(id: string): VersionedThing | null {
  return VERSIONED.find((v) => v.id === id) ?? null;
}

export function versionedLabel(id: string): string {
  return versionedById(id)?.label ?? id;
}

/** How a check went. Mirrors `LinkStatus`, and for the same reasons. */
export const VERSION_CHECK_STATES = ["ok", "blocked", "unreachable"] as const;

export type VersionCheckState = (typeof VERSION_CHECK_STATES)[number];

export const DRIFT_STATES = ["current", "behind", "ahead", "unknown"] as const;

export type DriftState = (typeof DRIFT_STATES)[number];

export const DRIFT_META: Record<DriftState, { label: string; blurb: string }> = {
  current: {
    label: "Current",
    blurb: "The version this skill names is the latest released.",
  },
  behind: {
    label: "Newer version released",
    blurb:
      "A newer version has shipped since this was written. That is information, not a fault: a skill teaching one version's idioms is exactly right for a codebase on that version.",
  },
  ahead: {
    label: "Ahead of the feed",
    blurb:
      "This names a version newer than the latest we could find — usually a pre-release, or a feed we are reading wrongly.",
  },
  unknown: {
    label: "Not checked",
    blurb: "Nobody has read this project's releases yet, so there is nothing to compare against.",
  },
};

/**
 * `"3.11.4"` → `[3, 11, 4]` — the first dotted numeric run, wherever it starts.
 *
 * **Not anchored, and that is the fix for a silent hole.** Requiring digits at the start read
 * `v26.8.2` fine and returned nothing for `swift-6.3.3-RELEASE`, `php-8.5.10` and `bun-v1.4.2`
 * — three of the nineteen verified feeds. Nothing would have errored: an unparseable version
 * compares as `unknown`, so Swift at 21 repositories would simply never have produced drift,
 * for ever, with every check green. A project stamps its own name into its tags and that is
 * ordinary; the version is the numbers.
 */
export function parseVersion(raw: string): number[] {
  const match = raw.trim().match(/(\d+(?:\.\d+)*)/);
  if (!match) return [];
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * Compare a pinned version against the latest released one, at the tracked precision.
 *
 * **Truncated to `precision` before comparing**, which is the whole reason that field exists:
 * `python 3.11` against a current `3.11.4` is *current*, not behind. Reporting drift on a
 * patch release would fire on nearly every document every month, and an alarm that frequent
 * is one people turn off — `ROT_THRESHOLD` exists for the same reason one layer along.
 *
 * A pin with fewer parts than the precision is compared on what it has: `python 3` against
 * `3.13` is current, because the author said 3 and meant 3.
 */
export function compareVersion(
  pinned: string,
  current: string,
  precision: "major" | "minor",
): DriftState {
  const a = parseVersion(pinned);
  const b = parseVersion(current);
  if (a.length === 0 || b.length === 0) return "unknown";

  const depth = Math.min(precision === "major" ? 1 : 2, a.length, b.length);
  for (let i = 0; i < depth; i += 1) {
    if (a[i] < b[i]) return "behind";
    if (a[i] > b[i]) return "ahead";
  }
  return "current";
}

/**
 * How far behind is worth telling somebody about.
 *
 * One release behind is ordinary and often deliberate; **two** is the point at which a skill
 * is teaching idioms most readers no longer have. Below this the drift is derived and not
 * surfaced, so the panel stays a short list worth looking at rather than a running commentary
 * on the release cadence of nineteen projects.
 */
export const DRIFT_STEPS_BEFORE_SURFACING = 2;

/** How many major versions behind, or null when that is not answerable. */
export function majorsBehind(pinned: string, current: string): number | null {
  const a = parseVersion(pinned);
  const b = parseVersion(current);
  if (a.length === 0 || b.length === 0) return null;
  return b[0] - a[0];
}

/**
 * How far behind **in the unit the project actually moves in**.
 *
 * Counting majors alone was wrong and the real-data check caught it: a skill pinning
 * `terraform 1.7.0` against a current `1.16.2` is nine releases behind and scored **zero
 * majors**, so it could never be surfaced — and neither could anything pinning `python`,
 * `go`, `rust` or `kubectl`, because those projects have lived on one major for years. A
 * threshold denominated in a unit half the list never moves in is a gate measured with
 * something that is not the gate, which is the mistake this codebase has made twice before.
 *
 * So a `minor`-precision project counts minors, and a major bump there (`python 3` → `4`)
 * counts as well past the threshold on its own, because it is the largest thing that can
 * happen to such a project.
 */
export function stepsBehind(
  pinned: string,
  current: string,
  precision: "major" | "minor",
): number | null {
  const a = parseVersion(pinned);
  const b = parseVersion(current);
  if (a.length === 0 || b.length === 0) return null;

  if (precision === "major" || b[0] !== a[0]) {
    const majors = b[0] - a[0];
    // A major move under minor precision is unambiguously worth saying, whatever the minors do.
    return precision === "minor" && majors > 0
      ? Math.max(majors, DRIFT_STEPS_BEFORE_SURFACING)
      : majors;
  }
  // Same major, minor precision: a pin with no minor part (`python 3`) is not behind on minors.
  if (a.length < 2 || b.length < 2) return 0;
  return b[1] - a[1];
}
