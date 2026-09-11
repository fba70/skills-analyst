/**
 * The tool vocabulary (Doc 7 RD.6, plan step P1) — what a skill tells an agent to run.
 *
 * A third axis beside `function` and `domain`, and the one consumers already think in: *I have
 * these tools, which skills can I run?* The registry can filter on it, an agent can ask for it
 * over MCP, the designer compares it against `allowed-tools` (P2), and the miner measures it
 * per category (P3).
 *
 * ## Written from a count, not from memory
 *
 * Doc 7 §4 says this list is seeded from the corpus, the way `seeds.ts` verifies every entry
 * against the GitHub API after three hand-written ones turned out to be 404s. So extractor
 * 2.1.0 counted first — 50,965 documents, **9,442 distinct candidate tokens**, 51% of skills
 * referencing at least one — and the entries below are the head of that table by **distinct
 * repositories**, read and curated. The repo counts in the comments are from that run
 * (2026-09-11) and are why each entry is here.
 *
 * Sorted by repositories rather than by references, because a generator shipping eighteen
 * skills that all call one CLI is one data point about the corpus and eighteen about the
 * generator — R3.4's distinct-structures argument, at token scale.
 *
 * **The tail is not in here and is not meant to be.** A token no entry names is reported as
 * *unrecognised* and counted, exactly as the unclassified block share is: that number is the
 * honest measure of whether this list is complete enough, and hiding it would make the facet
 * look finished. `verify:tools` fails if it ever reaches zero.
 *
 * ## Destined for the settings table
 *
 * Policy becomes data, and this is policy: adding a tool is a curation decision a redeploy
 * should not be needed for. It starts as code so the first version has one copy and a verify
 * suite — the same path the category vocabulary is on.
 *
 * A leaf module with no imports. The registry facet is a client component, the derivation is
 * `server-only`, and the verify script is neither.
 */

/**
 * What sort of thing it is. Not decoration: an `agent-builtin` is granted by the harness and an
 * absent one is a refused call (P2 reads this), while a `cli` has to be installed and a
 * `service` needs credentials.
 */
export const TOOL_KINDS = ["cli", "agent-builtin", "runtime", "service"] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export const TOOL_KIND_META: Record<ToolKind, { label: string; blurb: string }> = {
  cli: { label: "Command line", blurb: "A program the agent runs in a shell." },
  "agent-builtin": {
    label: "Agent built-in",
    blurb: "A capability the harness grants, named in `allowed-tools` rather than installed.",
  },
  runtime: { label: "Runtime", blurb: "A language runtime or package manager the skill assumes." },
  service: { label: "Hosted service", blurb: "A remote platform reached over the network." },
};

/**
 * Capability keys, mirroring R2.4's five.
 *
 * Duplicated as a type rather than imported from `capabilities.ts` so this module keeps no
 * imports; `verify:tools` asserts the two lists are equal, which is the check that makes the
 * duplication safe. Same posture `section-roles.ts` takes, with the check it lacked.
 */
export type ToolCapability = "network" | "fs_read" | "fs_write" | "shell" | "credentials";

export type Tool = {
  /** Stable slug, and the value stored in `skill_tools.tool`. Never renamed once assigned. */
  id: string;
  label: string;
  /** One line, for a reader deciding whether it matters to them. */
  blurb: string;
  kind: ToolKind;
  /** What R2.4 surfaces using it implies. Descriptive, never an accusation. */
  capabilities: readonly ToolCapability[];
  /**
   * Whether ordinary use of it can destroy data or change live state irreversibly.
   *
   * **Deliberately narrow.** RD.8 reads this to say *"you name a destructive tool and carry no
   * guardrail"*, and a flag that is true of everything is an alarm nobody can silence — the
   * lesson `ROT_THRESHOLD` and the marker threshold both paid for. So it is true only where a
   * common invocation deletes data (`rm`, `git reset --hard`), mutates production
   * (`kubectl delete`, `terraform apply`), or executes arbitrary code somewhere else (`ssh`).
   * Installing a package is not destructive; overwriting a file is.
   */
  destructive: boolean;
  /** Other tokens that mean this tool. Compared case-insensitively, like a repository name. */
  aliases?: readonly string[];
};

/*
 * No `releases` field yet, though Doc 7 RD.6 names one.
 *
 * RD.10's version-drift check needs to know where a tool announces releases, and a URL written
 * from memory is exactly what `seeds.ts` was burned by. Every entry here is justified by a
 * number from the corpus; a release feed cannot be, so it is **P5's** to add against a verified
 * fetch rather than a field that ships null and looks decided.
 */

const AGENT_BUILTIN: readonly Tool[] = [
  /*
   * Claude Code's `allowed-tools`, which 4,611 skills declare. These arrive almost entirely
   * through frontmatter — `read` and `grep` are also shell words, and `resolveTool` uses the
   * evidence to tell them apart.
   */
  { id: "agent:read", label: "Read", blurb: "Reads a file the harness grants access to.", kind: "agent-builtin", capabilities: ["fs_read"], destructive: false }, // 170 repos
  { id: "agent:write", label: "Write", blurb: "Creates a file through the harness.", kind: "agent-builtin", capabilities: ["fs_write"], destructive: false }, // 134
  { id: "agent:edit", label: "Edit", blurb: "Edits a file in place through the harness.", kind: "agent-builtin", capabilities: ["fs_write"], destructive: false }, // 106
  { id: "agent:glob", label: "Glob", blurb: "Finds files by pattern.", kind: "agent-builtin", capabilities: ["fs_read"], destructive: false }, // 125
  { id: "agent:grep", label: "Grep (built-in)", blurb: "Searches file contents through the harness.", kind: "agent-builtin", capabilities: ["fs_read"], destructive: false },
  { id: "agent:bash", label: "Bash (built-in)", blurb: "Runs shell commands through the harness — the grant every CLI below needs.", kind: "agent-builtin", capabilities: ["shell"], destructive: true },
  { id: "agent:webfetch", label: "WebFetch", blurb: "Fetches a URL.", kind: "agent-builtin", capabilities: ["network"], destructive: false }, // 59
  { id: "agent:websearch", label: "WebSearch", blurb: "Searches the web.", kind: "agent-builtin", capabilities: ["network"], destructive: false }, // 42
  { id: "agent:ask", label: "AskUserQuestion", blurb: "Puts a question to the person.", kind: "agent-builtin", capabilities: [], destructive: false }, // 53
  { id: "agent:task", label: "Task", blurb: "Delegates to a sub-agent.", kind: "agent-builtin", capabilities: [], destructive: false }, // 39
];

const VERSION_CONTROL: readonly Tool[] = [
  { id: "git", label: "git", blurb: "Version control.", kind: "cli", capabilities: ["fs_read", "fs_write", "shell"], destructive: true }, // 325 repos — the most referenced tool in the corpus
  { id: "gh", label: "gh", blurb: "GitHub from the command line: pull requests, issues, releases.", kind: "cli", capabilities: ["network", "credentials"], destructive: true, aliases: ["github-cli"] }, // 161
];

const PACKAGE_AND_RUNTIME: readonly Tool[] = [
  { id: "npm", label: "npm", blurb: "Node package manager.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 290
  { id: "npx", label: "npx", blurb: "Runs a Node package without installing it first.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 275
  { id: "pnpm", label: "pnpm", blurb: "Node package manager.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 87
  { id: "yarn", label: "yarn", blurb: "Node package manager.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 41
  { id: "bun", label: "bun", blurb: "JavaScript runtime and package manager.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false, aliases: ["bunx"] }, // 65 + 25
  { id: "node", label: "node", blurb: "JavaScript runtime.", kind: "runtime", capabilities: ["shell"], destructive: false }, // 188
  { id: "python", label: "python", blurb: "Python runtime.", kind: "runtime", capabilities: ["shell"], destructive: false, aliases: ["python3", "py"] }, // 199 + 238
  { id: "pip", label: "pip", blurb: "Python package installer.", kind: "runtime", capabilities: ["network", "fs_write"], destructive: false, aliases: ["pip3", "pipx"] }, // 138
  { id: "uv", label: "uv", blurb: "Python package and project manager.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false, aliases: ["uvx"] }, // 102 + 37
  { id: "cargo", label: "cargo", blurb: "Rust package manager and build tool.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 81
  { id: "go", label: "go", blurb: "Go toolchain.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 72
  { id: "dotnet", label: "dotnet", blurb: ".NET toolchain.", kind: "runtime", capabilities: ["network", "fs_write", "shell"], destructive: false }, // 24
  { id: "java", label: "java", blurb: "Java runtime.", kind: "runtime", capabilities: ["shell"], destructive: false }, // 21
  { id: "swift", label: "swift", blurb: "Swift toolchain.", kind: "runtime", capabilities: ["shell"], destructive: false }, // 20
  { id: "make", label: "make", blurb: "Runs a build target.", kind: "cli", capabilities: ["shell"], destructive: false }, // 47
  { id: "brew", label: "brew", blurb: "Homebrew package manager.", kind: "cli", capabilities: ["network", "fs_write"], destructive: false }, // 104
  { id: "apt", label: "apt", blurb: "Debian package manager.", kind: "cli", capabilities: ["network", "fs_write"], destructive: false, aliases: ["apt-get"] }, // 44 + 27
  { id: "winget", label: "winget", blurb: "Windows package manager.", kind: "cli", capabilities: ["network", "fs_write"], destructive: false }, // 22
];

const SHELL_AND_FILES: readonly Tool[] = [
  { id: "bash", label: "bash", blurb: "Shell. Runs whatever it is given.", kind: "cli", capabilities: ["shell"], destructive: true, aliases: ["sh", "zsh"] }, // 293 + 46
  { id: "powershell", label: "PowerShell", blurb: "Windows shell.", kind: "cli", capabilities: ["shell"], destructive: true, aliases: ["pwsh", "iex"] }, // 17 + 21
  { id: "grep", label: "grep", blurb: "Searches text.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 278
  { id: "rg", label: "ripgrep", blurb: "Fast recursive search.", kind: "cli", capabilities: ["fs_read"], destructive: false, aliases: ["ripgrep"] }, // 52
  { id: "sed", label: "sed", blurb: "Stream editor.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false }, // 88
  { id: "awk", label: "awk", blurb: "Text processing language.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 64
  { id: "jq", label: "jq", blurb: "Reads and reshapes JSON.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 152
  { id: "find", label: "find", blurb: "Walks the filesystem.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 115
  { id: "rm", label: "rm", blurb: "Deletes files.", kind: "cli", capabilities: ["fs_write"], destructive: true }, // 135
  { id: "mv", label: "mv", blurb: "Moves or renames, overwriting what is there.", kind: "cli", capabilities: ["fs_write"], destructive: true }, // 57
  { id: "cp", label: "cp", blurb: "Copies files.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false }, // 133
  { id: "chmod", label: "chmod", blurb: "Changes file permissions.", kind: "cli", capabilities: ["fs_write"], destructive: false }, // 66
  { id: "tar", label: "tar", blurb: "Archives and extracts.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false }, // 31
  { id: "zip", label: "zip", blurb: "Archives and extracts.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false, aliases: ["unzip"] }, // 19 + 32
  { id: "xargs", label: "xargs", blurb: "Runs a command once per input line.", kind: "cli", capabilities: ["shell"], destructive: false }, // 58

  /*
   * The coreutils head, and it is here on the data's say-so rather than on taste.
   *
   * The tempting line is *a tool earns a place if knowing about it changes a decision* —
   * nobody lacks `cat`, nobody is careful about `wc`. Drawn that way the list would exclude
   * `cat` at **191 repositories** while keeping `qpdf` at 19, which is not a defensible
   * reading of the table this list was written from; and it would inflate the unrecognised
   * share with tokens the vocabulary had recognised and declined. Noise in a facet is a
   * presentation problem — the page groups by kind and orders by count — while curating by
   * taste is the "written from memory" failure this whole step exists to avoid.
   */
  { id: "cat", label: "cat", blurb: "Prints a file.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 191
  { id: "mkdir", label: "mkdir", blurb: "Creates a directory.", kind: "cli", capabilities: ["fs_write"], destructive: false }, // 180
  { id: "ls", label: "ls", blurb: "Lists a directory.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 160
  { id: "head", label: "head", blurb: "Prints the first lines of a file.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 141
  { id: "tail", label: "tail", blurb: "Prints the last lines of a file, or follows it.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 93
  { id: "wc", label: "wc", blurb: "Counts lines, words and bytes.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 91
  { id: "sort", label: "sort", blurb: "Sorts lines.", kind: "cli", capabilities: ["fs_read"], destructive: false, aliases: ["uniq"] }, // 81 + 32
  { id: "sleep", label: "sleep", blurb: "Waits.", kind: "cli", capabilities: [], destructive: false, aliases: ["timeout"] }, // 68 + 27
  { id: "which", label: "which", blurb: "Reports whether a command is installed.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 62
  { id: "open", label: "open", blurb: "Opens a file or URL in the desktop's default application.", kind: "cli", capabilities: [], destructive: false }, // 54
  { id: "tr", label: "tr", blurb: "Translates or deletes characters.", kind: "cli", capabilities: [], destructive: false }, // 54
  { id: "cut", label: "cut", blurb: "Selects columns from each line.", kind: "cli", capabilities: [], destructive: false }, // 52
  { id: "kill", label: "kill", blurb: "Signals a running process.", kind: "cli", capabilities: ["shell"], destructive: true, aliases: ["pkill"] }, // 45 + 19
  { id: "diff", label: "diff", blurb: "Compares two files.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 39
  { id: "base64", label: "base64", blurb: "Encodes and decodes base64.", kind: "cli", capabilities: [], destructive: false, aliases: ["shasum"] }, // 39 + 16
  { id: "pwd", label: "pwd", blurb: "Prints the working directory.", kind: "cli", capabilities: [], destructive: false }, // 38
  { id: "touch", label: "touch", blurb: "Creates an empty file or updates its timestamp.", kind: "cli", capabilities: ["fs_write"], destructive: false }, // 37
  { id: "ln", label: "ln", blurb: "Makes a link.", kind: "cli", capabilities: ["fs_write"], destructive: false }, // 37
  { id: "date", label: "date", blurb: "Prints or formats the time.", kind: "cli", capabilities: [], destructive: false }, // 36
  { id: "tee", label: "tee", blurb: "Writes a stream to a file and passes it on.", kind: "cli", capabilities: ["fs_write"], destructive: false }, // 35
  { id: "uname", label: "uname", blurb: "Reports the operating system.", kind: "cli", capabilities: [], destructive: false }, // 30
  { id: "lsof", label: "lsof", blurb: "Lists open files and the ports in use.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 28
  { id: "ps", label: "ps", blurb: "Lists running processes.", kind: "cli", capabilities: ["shell"], destructive: false }, // 22
  { id: "du", label: "du", blurb: "Reports disk usage.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 18
  { id: "nc", label: "nc", blurb: "Opens a raw network connection.", kind: "cli", capabilities: ["network"], destructive: false }, // 16
];

const NETWORK_AND_CLOUD: readonly Tool[] = [
  { id: "curl", label: "curl", blurb: "Makes HTTP requests.", kind: "cli", capabilities: ["network"], destructive: false }, // 240
  { id: "wget", label: "wget", blurb: "Downloads over HTTP.", kind: "cli", capabilities: ["network", "fs_write"], destructive: false }, // 24
  { id: "ssh", label: "ssh", blurb: "Runs commands on another machine.", kind: "cli", capabilities: ["network", "credentials", "shell"], destructive: true }, // 30
  { id: "docker", label: "docker", blurb: "Builds and runs containers.", kind: "cli", capabilities: ["network", "shell", "fs_write"], destructive: true, aliases: ["docker-compose", "podman"] }, // 92
  { id: "kubectl", label: "kubectl", blurb: "Talks to a Kubernetes cluster.", kind: "cli", capabilities: ["network", "credentials"], destructive: true }, // 49
  { id: "helm", label: "helm", blurb: "Deploys Kubernetes charts.", kind: "cli", capabilities: ["network", "credentials"], destructive: true }, // 23
  { id: "terraform", label: "terraform", blurb: "Plans and applies infrastructure.", kind: "cli", capabilities: ["network", "credentials"], destructive: true, aliases: ["tofu", "opentofu"] }, // 34
  { id: "aws", label: "aws", blurb: "Amazon Web Services from the command line.", kind: "service", capabilities: ["network", "credentials"], destructive: true }, // 37
  { id: "gcloud", label: "gcloud", blurb: "Google Cloud from the command line.", kind: "service", capabilities: ["network", "credentials"], destructive: true }, // 23
  { id: "az", label: "az", blurb: "Azure from the command line.", kind: "service", capabilities: ["network", "credentials"], destructive: true }, // 25
  { id: "vercel", label: "vercel", blurb: "Deploys to Vercel.", kind: "service", capabilities: ["network", "credentials"], destructive: true }, // 20
  { id: "psql", label: "psql", blurb: "Postgres client. Runs whatever SQL it is given.", kind: "cli", capabilities: ["network", "credentials"], destructive: true }, // 21
  { id: "systemctl", label: "systemctl", blurb: "Starts and stops system services.", kind: "cli", capabilities: ["shell"], destructive: true }, // 28
  { id: "crontab", label: "crontab", blurb: "Schedules recurring commands.", kind: "cli", capabilities: ["shell"], destructive: true }, // 16
  { id: "openssl", label: "openssl", blurb: "Cryptography and certificates.", kind: "cli", capabilities: ["credentials"], destructive: false }, // 29
  { id: "dig", label: "dig", blurb: "Queries DNS.", kind: "cli", capabilities: ["network"], destructive: false }, // 16
];

const QUALITY_AND_BUILD: readonly Tool[] = [
  { id: "pytest", label: "pytest", blurb: "Runs Python tests.", kind: "cli", capabilities: ["shell"], destructive: false }, // 46
  { id: "ruff", label: "ruff", blurb: "Lints and formats Python.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false }, // 29
  { id: "mypy", label: "mypy", blurb: "Type-checks Python.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 17
  { id: "tsc", label: "tsc", blurb: "Type-checks TypeScript.", kind: "cli", capabilities: ["fs_read"], destructive: false }, // 46
  { id: "trivy", label: "trivy", blurb: "Scans images and code for vulnerabilities.", kind: "cli", capabilities: ["network", "fs_read"], destructive: false }, // 17
  { id: "pip-audit", label: "pip-audit", blurb: "Audits Python dependencies.", kind: "cli", capabilities: ["network"], destructive: false }, // 17
  { id: "xcodebuild", label: "xcodebuild", blurb: "Builds Apple projects.", kind: "cli", capabilities: ["shell"], destructive: false, aliases: ["xcrun"] }, // 19
];

const MEDIA_AND_DOCUMENTS: readonly Tool[] = [
  { id: "ffmpeg", label: "ffmpeg", blurb: "Converts audio and video.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false, aliases: ["ffprobe"] }, // 47
  { id: "pandoc", label: "pandoc", blurb: "Converts between document formats.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false }, // 27
  { id: "pdftotext", label: "pdftotext", blurb: "Extracts text from a PDF.", kind: "cli", capabilities: ["fs_read"], destructive: false, aliases: ["pdftoppm", "pdfimages"] }, // 24
  { id: "qpdf", label: "qpdf", blurb: "Transforms PDFs.", kind: "cli", capabilities: ["fs_read", "fs_write"], destructive: false, aliases: ["pdftk"] }, // 19
  { id: "yt-dlp", label: "yt-dlp", blurb: "Downloads media from the web.", kind: "cli", capabilities: ["network", "fs_write"], destructive: false }, // 16
];

const AGENT_CLIS: readonly Tool[] = [
  /* Agents driving agents. A skill naming one expects that harness to be installed. */
  { id: "claude", label: "Claude Code", blurb: "Anthropic's coding agent, from the command line.", kind: "cli", capabilities: ["network", "shell", "credentials"], destructive: true }, // 116
  { id: "codex", label: "Codex", blurb: "OpenAI's coding agent.", kind: "cli", capabilities: ["network", "shell", "credentials"], destructive: true }, // 48
  { id: "gemini", label: "Gemini CLI", blurb: "Google's coding agent.", kind: "cli", capabilities: ["network", "shell", "credentials"], destructive: true }, // 25
  { id: "openclaw", label: "OpenClaw", blurb: "An open agent harness.", kind: "cli", capabilities: ["network", "shell"], destructive: true }, // 22
  { id: "tmux", label: "tmux", blurb: "Terminal multiplexer — how an agent keeps a long session alive.", kind: "cli", capabilities: ["shell"], destructive: false }, // 21
];

export const TOOLS: readonly Tool[] = [
  ...AGENT_BUILTIN,
  ...VERSION_CONTROL,
  ...PACKAGE_AND_RUNTIME,
  ...SHELL_AND_FILES,
  ...NETWORK_AND_CLOUD,
  ...QUALITY_AND_BUILD,
  ...MEDIA_AND_DOCUMENTS,
  ...AGENT_CLIS,
];

export const TOOL_IDS: readonly string[] = TOOLS.map((t) => t.id);

export function isToolId(value: unknown): value is string {
  return typeof value === "string" && TOOL_IDS.includes(value);
}

export function toolById(id: string): Tool | null {
  return TOOLS.find((t) => t.id === id) ?? null;
}

export function toolLabel(id: string): string {
  return toolById(id)?.label ?? id;
}

/**
 * Where a reference was seen. The order is the order of confidence, and P2 compares them.
 *
 * `frontmatter` is a declaration, `code` is an invocation, `prose` is a mention the document
 * confirmed elsewhere. A skill whose steps run `kubectl` with no `kubectl` in `allowed-tools`
 * is the disagreement RD.8 reports, and it is only visible because these are kept apart.
 */
export const TOOL_EVIDENCE = ["frontmatter", "code", "prose"] as const;

export type ToolEvidence = (typeof TOOL_EVIDENCE)[number];

export const TOOL_EVIDENCE_META: Record<ToolEvidence, { label: string; blurb: string }> = {
  frontmatter: { label: "Declared", blurb: "Listed in the skill's own `allowed-tools`." },
  code: { label: "Invoked", blurb: "A command line in the skill runs it." },
  prose: { label: "Mentioned", blurb: "Named in the text, and invoked somewhere in the same skill." },
};

/** Token → tool id, built once. Ids, aliases and the bare name of a prefixed built-in. */
const BY_TOKEN = new Map<string, string>();
for (const tool of TOOLS) {
  const bare = tool.id.startsWith("agent:") ? tool.id.slice("agent:".length) : tool.id;
  BY_TOKEN.set(bare.toLowerCase(), tool.id);
  BY_TOKEN.set(tool.id.toLowerCase(), tool.id);
  for (const alias of tool.aliases ?? []) BY_TOKEN.set(alias.toLowerCase(), tool.id);
}

/** Built-in ids keyed by the bare token, so `read` from frontmatter is not the shell word. */
const BUILTIN_BY_TOKEN = new Map(
  AGENT_BUILTIN.map((t) => [t.id.slice("agent:".length).toLowerCase(), t.id] as const),
);

/*
 * `askuserquestion` is what `allowed-tools` writes; `ask` is what the id says. Kept here rather
 * than as an alias because the alias map is keyed on the bare id and this is the other way round.
 */
BY_TOKEN.set("askuserquestion", "agent:ask");
BUILTIN_BY_TOKEN.set("askuserquestion", "agent:ask");

/**
 * Resolve one extracted token to a tool id, or null when nothing names it.
 *
 * **The evidence decides between a built-in and a command**, and it has to: `grep` and `bash`
 * are both a Claude Code tool and a program, and `read`, `write`, `edit` and `glob` are words
 * a shell also knows. A token from `allowed-tools` is a declaration by the author that the
 * harness grants it; the same token on a command line is the program. Resolving on the string
 * alone would put 3,438 `Read` declarations under a shell builtin nobody invokes.
 *
 * Null is a normal answer and is counted as *unrecognised*, never dropped silently.
 */
export function resolveTool(token: string, evidence: ToolEvidence): string | null {
  const key = token.toLowerCase();
  if (evidence === "frontmatter") {
    const builtin = BUILTIN_BY_TOKEN.get(key);
    if (builtin) return builtin;
  }
  const id = BY_TOKEN.get(key);
  if (!id) return null;
  /*
   * Outside frontmatter a built-in's bare name means the program, and `BY_TOKEN` already holds
   * it: the CLI entries are declared after the built-ins, so `grep` and `bash` resolve to the
   * programs and only `read`, `write`, `edit` and the rest — which no CLI claims — are left
   * pointing at an `agent:` id. Those are shell words the detector filters anyway, so null is
   * the honest answer rather than a harness tool nobody declared.
   */
  if (evidence !== "frontmatter" && id.startsWith("agent:")) return null;
  return id;
}

/** Every tool a set of extracted `(token, evidence)` pairs names, plus what nothing named. */
export function resolveTools(
  refs: ReadonlyArray<{ token: string; evidence: ToolEvidence }>,
): { tools: Array<{ id: string; evidence: ToolEvidence }>; unrecognised: string[] } {
  const best = new Map<string, ToolEvidence>();
  const unrecognised = new Set<string>();
  for (const ref of refs) {
    const id = resolveTool(ref.token, ref.evidence);
    if (!id) {
      unrecognised.add(ref.token);
      continue;
    }
    const held = best.get(id);
    // Strongest evidence wins: declared beats invoked beats mentioned.
    if (!held || TOOL_EVIDENCE.indexOf(ref.evidence) < TOOL_EVIDENCE.indexOf(held)) {
      best.set(id, ref.evidence);
    }
  }
  return {
    tools: [...best.entries()].map(([id, evidence]) => ({ id, evidence })).sort((a, b) => a.id.localeCompare(b.id)),
    unrecognised: [...unrecognised].sort(),
  };
}

/** The destructive tools in a set — RD.8's input, and the only place the flag is read. */
export function destructiveAmong(ids: readonly string[]): string[] {
  return ids.filter((id) => toolById(id)?.destructive === true);
}
