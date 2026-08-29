import "server-only";

/**
 * Reading a licence from text, and turning it into a redistribution decision.
 *
 * The decision is deliberately conservative: anything we cannot positively identify as
 * permitting copying resolves to `unresolved`, and `unresolved` withholds the bytes. The
 * cost of being wrong in one direction is a missing mirror; in the other it is
 * redistributing someone's proprietary code.
 */

export type RedistributionPosture =
  | "mirror_allowed"
  | "attribution_required"
  | "metadata_only"
  | "unresolved";

export type LicenseReading = {
  spdx: string | null;
  posture: RedistributionPosture;
  /** Why we concluded this — stored as evidence on the skill version. */
  matched: string;
};

/**
 * Positive identification by licence body text, not by file name.
 *
 * A file called LICENSE.txt proves nothing; `anthropics/skills` has one in every skill
 * directory and half of them are proprietary.
 */
const BODY_SIGNATURES: Array<{
  spdx: string;
  posture: RedistributionPosture;
  pattern: RegExp;
}> = [
  {
    spdx: "Apache-2.0",
    posture: "attribution_required",
    pattern: /Apache License\s*,?\s*Version 2\.0/i,
  },
  {
    spdx: "MIT",
    posture: "attribution_required",
    pattern: /Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  },
  {
    spdx: "BSD-3-Clause",
    posture: "attribution_required",
    pattern: /Neither the name of the .{0,60} nor the names of its\s+contributors/i,
  },
  {
    spdx: "BSD-2-Clause",
    posture: "attribution_required",
    pattern: /Redistribution and use in source and binary forms[\s\S]{0,400}2\. Redistributions in binary form/i,
  },
  {
    spdx: "ISC",
    posture: "attribution_required",
    pattern: /Permission to use, copy, modify, and\/or distribute this software for any/i,
  },
  {
    spdx: "MPL-2.0",
    posture: "attribution_required",
    pattern: /Mozilla Public License Version 2\.0/i,
  },
  {
    spdx: "GPL-3.0",
    posture: "attribution_required",
    pattern: /GNU GENERAL PUBLIC LICENSE\s+Version 3/i,
  },
  {
    spdx: "AGPL-3.0",
    posture: "attribution_required",
    pattern: /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i,
  },
  {
    spdx: "Unlicense",
    posture: "mirror_allowed",
    pattern: /This is free and unencumbered software released into the public domain/i,
  },
  {
    spdx: "CC0-1.0",
    posture: "mirror_allowed",
    pattern: /CC0 1\.0 Universal/i,
  },
];

/**
 * Phrases that forbid copying regardless of anything else. Checked FIRST, because a
 * proprietary licence can quote a permissive one while granting nothing.
 */
const PROPRIETARY_SIGNATURES: Array<{ label: string; pattern: RegExp }> = [
  { label: "all-rights-reserved", pattern: /All rights reserved/i },
  { label: "proprietary", pattern: /\bproprietary\b/i },
  { label: "source-available", pattern: /source[- ]available/i },
  { label: "no-redistribution", pattern: /may not be (copied|redistributed|reproduced)/i },
  { label: "noncommercial", pattern: /NonCommercial|CC BY-NC|\bNC\b-/i },
  { label: "noderivatives", pattern: /NoDerivatives|CC BY-ND/i },
];

/** Reads a licence file's body. */
export function readLicenseText(text: string): LicenseReading {
  const head = text.slice(0, 8000);

  for (const signature of PROPRIETARY_SIGNATURES) {
    if (signature.pattern.test(head)) {
      return { spdx: null, posture: "metadata_only", matched: `text:${signature.label}` };
    }
  }

  for (const signature of BODY_SIGNATURES) {
    if (signature.pattern.test(head)) {
      return {
        spdx: signature.spdx,
        posture: signature.posture,
        matched: `text:${signature.spdx}`,
      };
    }
  }

  return { spdx: null, posture: "unresolved", matched: "text:unrecognised" };
}

/**
 * Reads the frontmatter `license:` field.
 *
 * In practice this is free text — `anthropics/skills` writes
 * "Complete terms in LICENSE.txt" and "Proprietary. LICENSE.txt has complete terms". So
 * it is a *signal*, not an answer: a clear proprietary statement is decisive, a clean SPDX
 * id is decisive, and anything else defers to the licence file.
 */
export function readFrontmatterLicense(value: unknown): LicenseReading | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;

  for (const signature of PROPRIETARY_SIGNATURES) {
    if (signature.pattern.test(text)) {
      return {
        spdx: null,
        posture: "metadata_only",
        matched: `frontmatter:${signature.label}`,
      };
    }
  }

  // A bare SPDX id, e.g. "MIT" or "Apache-2.0".
  const spdx = matchSpdxId(text);
  if (spdx) {
    return { spdx: spdx.spdx, posture: spdx.posture, matched: "frontmatter:spdx" };
  }

  // A pointer such as "Complete terms in LICENSE.txt" — defer to the file.
  return null;
}

/** Maps a known SPDX identifier to a posture. */
export function matchSpdxId(
  value: string,
): { spdx: string; posture: RedistributionPosture } | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!/^[A-Za-z0-9.\-+]+$/.test(normalized)) return null;

  const known: Record<string, RedistributionPosture> = {
    "MIT": "attribution_required",
    "Apache-2.0": "attribution_required",
    "BSD-2-Clause": "attribution_required",
    "BSD-3-Clause": "attribution_required",
    "ISC": "attribution_required",
    "MPL-2.0": "attribution_required",
    "GPL-3.0": "attribution_required",
    "GPL-3.0-only": "attribution_required",
    "GPL-2.0": "attribution_required",
    "LGPL-3.0": "attribution_required",
    "AGPL-3.0": "attribution_required",
    "Unlicense": "mirror_allowed",
    "CC0-1.0": "mirror_allowed",
    "CC-BY-4.0": "attribution_required",
    "CC-BY-SA-4.0": "attribution_required",
    "CC-BY-NC-4.0": "metadata_only",
    "CC-BY-ND-4.0": "metadata_only",
    "CC-BY-NC-SA-4.0": "metadata_only",
    "NOASSERTION": "unresolved",
  };

  const match = Object.keys(known).find(
    (id) => id.toLowerCase() === normalized.toLowerCase(),
  );
  return match ? { spdx: match, posture: known[match] } : null;
}
