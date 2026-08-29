import "server-only";

import type { Analyzer, Finding } from "../types";

/**
 * Prompt injection and instruction hijack (Doc 2 R2.2).
 *
 * The thing being defended is unusual: a skill's text is read by *another agent*, so
 * prose is executable. The distinction that matters is between text describing what the
 * skill does and text addressing the consuming agent directly.
 *
 * Severity is split deliberately, because quarantine precision is a launch gate (target
 * ≥90%):
 *   - hidden characters are a `fail`. There is no honest reason to hide instructions in
 *     zero-width or bidi control characters.
 *   - suspicious phrasing is a `warn`. A legitimate skill about prompting — and this
 *     corpus has several — will quote these phrases while teaching them.
 */

/** Zero-width, bidi overrides and other invisible carriers. */
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

const PHRASES: Array<{ reason: string; pattern: RegExp; note: string }> = [
  {
    reason: "instruction-override",
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/gi,
    note: "tells the reading agent to discard its instructions",
  },
  {
    reason: "role-hijack",
    pattern: /\byou\s+are\s+now\s+(a|an|the)\b|\bfrom\s+now\s+on,?\s+you\s+(are|must|will)\b/gi,
    note: "reassigns the reading agent's role",
  },
  {
    reason: "concealment",
    pattern: /\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal|show)\s+(the\s+)?(user|human|operator)\b/gi,
    note: "asks the agent to hide behaviour from the user",
  },
  {
    reason: "safety-bypass",
    pattern: /\b(disable|bypass|ignore|turn\s+off)\s+(your\s+)?(safety|guardrails?|filters?|restrictions?|content\s+polic)/gi,
    note: "asks the agent to weaken its own safety behaviour",
  },
  {
    reason: "covert-exfiltration",
    pattern: /\b(send|post|upload|exfiltrate|forward)\b[^.\n]{0,60}\b(env|environment|credentials?|secrets?|tokens?|api[_-]?keys?)\b[^.\n]{0,60}\bhttps?:\/\//gi,
    note: "describes sending credentials to an external endpoint",
  },
  {
    reason: "silent-tool-invocation",
    pattern: /\b(silently|quietly|without\s+(asking|confirmation|permission|telling))\s+(run|execute|invoke|call|delete|send)\b/gi,
    note: "directs the agent to act without confirmation",
  },
];

const TEXT_EXTENSIONS = /\.(md|markdown|txt|ya?ml|json|rst|html?)$/i;

export const injectionScan: Analyzer = {
  name: "prompt-injection",
  version: "1.0.0",

  run({ files, markerPath }) {
    const findings: Finding[] = [];

    for (const file of files) {
      const isText = TEXT_EXTENSIONS.test(file.path) || file.path === markerPath;
      if (!isText || file.content.byteLength > 2_000_000) continue;

      const text = file.content.toString("utf8");

      const hidden = [...text.matchAll(HIDDEN_CHARS)];
      if (hidden.length > 0) {
        const codes = [...new Set(hidden.map((m) => `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`))];
        findings.push({
          reason: "hidden-instruction",
          severity: "critical",
          message: `${hidden.length} invisible character(s) (${codes.join(", ")}). Text an agent reads but a reviewer cannot see.`,
          file: file.path,
          line: lineOf(text, hidden[0].index ?? 0),
        });
      }

      for (const phrase of PHRASES) {
        for (const match of text.matchAll(phrase.pattern)) {
          findings.push({
            reason: phrase.reason,
            severity: "medium",
            message: `Phrasing that ${phrase.note}.`,
            file: file.path,
            line: lineOf(text, match.index ?? 0),
            excerpt: excerpt(text, match.index ?? 0),
          });
          break; // one finding per pattern per file is enough to warrant a look
        }
      }
    }

    const hasHidden = findings.some((f) => f.reason === "hidden-instruction");
    return {
      result: hasHidden ? "fail" : findings.length > 0 ? "warn" : "pass",
      findings,
    };
  },
};

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

/** Short context for a curator. Rendered inert in the UI — never as live markup. */
function excerpt(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, index + 120).replace(/\s+/g, " ").trim().slice(0, 160);
}
