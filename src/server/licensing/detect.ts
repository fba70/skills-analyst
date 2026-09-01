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
  /**
   * Creative Commons, by body text.
   *
   * The SPDX *id* map below has known `CC-BY-4.0` and `CC-BY-SA-4.0` since the beginning —
   * what was missing is the ability to recognise one of these licences from the file itself,
   * so a repository whose LICENSE is a plain-prose CC grant fell through to `unresolved`.
   * GitHub reports NOASSERTION for exactly these files (their text does not match the
   * canonical CC wording byte for byte), which is why step 3 could not rescue them either.
   *
   * Measured before adding: of 1,968 unresolved skills, 85 repositories holding 1,713 of
   * them have **no licence at all** — correctly unresolved, and nothing can change that.
   * The remainder are these: one 710-star repository alone carries 166 skills under a
   * CC BY-SA 4.0 file nothing in the chain could read.
   *
   * Safe to treat as permissive because the restrictive variants are caught **first**:
   * `PROPRIETARY_SIGNATURES` tests NonCommercial and NoDerivatives above, so a CC BY-NC-SA
   * file never reaches these patterns.
   */
  {
    spdx: "CC-BY-SA-4.0",
    posture: "attribution_required",
    pattern: /Creative Commons Attribution[-\s]?ShareAlike 4\.0/i,
  },
  {
    spdx: "CC-BY-4.0",
    posture: "attribution_required",
    pattern: /Creative Commons Attribution 4\.0/i,
  },
  /**
   * LGPL, which the chain could name by id and not by text — the same gap as CC, and it is
   * `attribution_required` for our purposes: mirroring is permitted, attribution is not
   * optional. The copyleft obligations bind a *derivative*, which we do not create.
   */
  {
    spdx: "LGPL-2.1",
    posture: "attribution_required",
    pattern: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1|lgpl-2\.1/i,
  },
  {
    spdx: "LGPL-3.0",
    posture: "attribution_required",
    pattern: /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i,
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
  /**
   * Source-available licences that read as open and are not.
   *
   * Elastic 2.0 permits use and modification but forbids offering the software as a hosted
   * service, which is a redistribution restriction we cannot honour by mirroring. It reached
   * `unresolved` before, which is the same posture by accident; naming it makes the refusal
   * explainable to the author instead of looking like we failed to read their file.
   */
  { label: "elastic-2.0", pattern: /Elastic License 2\.0/i },
  { label: "busl", pattern: /Business Source License/i },
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
