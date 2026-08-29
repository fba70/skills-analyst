import "server-only";

import type { Analyzer, Finding } from "../types";

/**
 * What a skill can reach (Doc 2 R2.4).
 *
 * This is metadata, not a judgement — a skill that opens sockets is not suspect, it is
 * *described*. The surface exists so downstream consumers can reason about risk when
 * combining skills, and so the Phase 4 composition analysis has something to work from.
 * It must be recorded at ingest because it cannot be reconstructed later from content we
 * may not be allowed to keep.
 *
 * The one thing it does flag is a *documentation gap*: a capability the code has and the
 * documentation never mentions. That is a cheap approximation of R2.3, which needs an LLM
 * to do properly.
 */

export type Capability = "network" | "fs_read" | "fs_write" | "shell" | "credentials";

const SIGNATURES: Record<Capability, Array<{ pattern: RegExp; label: string }>> = {
  network: [
    { pattern: /\bfetch\s*\(|\baxios\b|\brequests\.(get|post|put|delete)|\burllib\b|\bhttpx\b/i, label: "http client" },
    { pattern: /\bsocket\.(socket|create_connection)|\bnet\.(connect|createConnection)/i, label: "raw socket" },
    { pattern: /\bcurl\b|\bwget\b/i, label: "curl/wget" },
    { pattern: /\bWebSocket\b|\bwebsockets\b/i, label: "websocket" },
  ],
  fs_read: [
    { pattern: /\bopen\s*\([^)]*['"]r|\breadFile(Sync)?\b|\bPath\([^)]*\)\.read_|\bfs\.read/i, label: "file read" },
    { pattern: /\bglob\b|\bos\.walk\b|\breaddir(Sync)?\b/i, label: "directory walk" },
  ],
  fs_write: [
    { pattern: /\bopen\s*\([^)]*['"][wax]|\bwriteFile(Sync)?\b|\bfs\.write|\bPath\([^)]*\)\.write_/i, label: "file write" },
    { pattern: /\bos\.(remove|unlink|rmdir)\b|\bshutil\.(rmtree|move|copy)/i, label: "file delete/move" },
    { pattern: /\brm\s+-rf\b/i, label: "rm -rf" },
  ],
  shell: [
    { pattern: /\bsubprocess\.(run|call|Popen|check_output)|\bos\.system\b|\bos\.popen\b/i, label: "python subprocess" },
    { pattern: /\bchild_process\b|\bexecSync?\s*\(|\bspawnSync?\s*\(/i, label: "node child_process" },
    { pattern: /\beval\s*\(|\bexec\s*\(/i, label: "eval/exec" },
  ],
  credentials: [
    { pattern: /\bos\.environ\b|\bprocess\.env\b|\bgetenv\b|\bdotenv\b/i, label: "environment variables" },
    { pattern: /\.aws\/credentials|\.ssh\/id_|\.netrc|\.npmrc|\.docker\/config/i, label: "credential file path" },
    { pattern: /\bkeychain\b|\bkeyring\b|\bcredential[_-]?manager\b/i, label: "credential store" },
  ],
};

/** Words in the documentation that count as disclosing a capability. */
const DOCUMENTED: Record<Capability, RegExp> = {
  network: /\b(network|http|https|api|url|request|download|upload|fetch|endpoint|internet|online|web)\b/i,
  fs_read: /\b(read|load|open|parse|input|file|directory|folder|path)\b/i,
  fs_write: /\b(write|save|create|output|generate|export|produce|delete|remove|modif)\w*\b/i,
  shell: /\b(shell|command|subprocess|script|execute|run|cli|terminal|bash)\b/i,
  credentials: /\b(credential|token|api[- ]?key|secret|auth|environment variable|env var|\.env)\b/i,
};

const CODE_EXTENSIONS = /\.(py|js|mjs|cjs|ts|tsx|sh|bash|zsh|rb|go|rs|php|pl|ps1)$/i;

export const capabilitySurface: Analyzer = {
  name: "capability-surface",
  version: "1.0.0",

  run({ files, body, frontmatter, markerPath }) {
    const surface: Record<string, { present: boolean; evidence: string[] }> = {};
    for (const capability of Object.keys(SIGNATURES) as Capability[]) {
      surface[capability] = { present: false, evidence: [] };
    }

    for (const file of files) {
      if (file.path === markerPath) continue;
      if (!CODE_EXTENSIONS.test(file.path)) continue;
      if (file.content.byteLength > 2_000_000) continue;

      const text = file.content.toString("utf8");
      for (const [capability, rules] of Object.entries(SIGNATURES) as Array<
        [Capability, Array<{ pattern: RegExp; label: string }>]
      >) {
        for (const rule of rules) {
          if (!rule.pattern.test(text)) continue;
          surface[capability].present = true;
          const note = `${file.path}: ${rule.label}`;
          if (!surface[capability].evidence.includes(note)) {
            surface[capability].evidence.push(note);
          }
        }
      }
    }

    // A capability the code has and the documentation never mentions.
    const documentation = `${body}\n${JSON.stringify(frontmatter)}`;
    const undocumented = (Object.keys(SIGNATURES) as Capability[]).filter(
      (capability) => surface[capability].present && !DOCUMENTED[capability].test(documentation),
    );

    const findings: Finding[] = undocumented.map((capability) => ({
      reason: `undocumented-capability:${capability}`,
      severity: "medium",
      message: `Bundled code uses ${capability.replace("_", " ")}, and the documentation never mentions it.`,
      excerpt: surface[capability].evidence.slice(0, 3).join("; "),
    }));

    return {
      // Recording a surface is never itself a failure; the gap is a warning.
      result: findings.length > 0 ? "warn" : "pass",
      findings,
      data: {
        surface,
        undocumented,
        capabilities: (Object.keys(SIGNATURES) as Capability[]).filter(
          (capability) => surface[capability].present,
        ),
      },
    };
  },
};
