import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { archetypes, events } from "@/server/db/schema";
import { db } from "@/server/db";
import { EXTRACTOR_VERSION } from "@/server/analytics/structure";
import { FUNCTIONS, TAXONOMY_VERSION } from "@/server/taxonomy/vocabulary";

import { mineArchetype, MINER_VERSION, type Archetype } from "./archetype";

/**
 * Persisting mined archetypes (Doc 2 R3.2).
 *
 * Append-only and versioned per category, matching `verdicts`: a regeneration writes a new
 * row and never edits the last one. R7.2 needs any archetype reproducible from stored
 * inputs, and R3.5 needs version N-1 present to diff conventions over time — both are lost
 * the moment a row is updated in place.
 *
 * The three pinned versions on every row (`extractorVersion`, `minerVersion`,
 * `taxonomyVersion`) are what make "reproducible" a fact rather than a hope. An archetype
 * mined under a different taxonomy is a different claim, even from identical skills.
 */

export type PersistResult = {
  category: string;
  version: number | null;
  stored: boolean;
  reason: string;
  archetype: Archetype | null;
};

/**
 * Skips writing when nothing meaningful moved.
 *
 * A weekly regeneration over a corpus that gained twelve skills would otherwise pile up
 * near-identical versions, and a changelog of "nothing changed" fifty times over makes the
 * genuine changes impossible to find. Comparing the skeleton is the honest test — if the
 * guidance is identical, there is no new archetype, whatever the counts did.
 */
function skeletonsMatch(a: unknown, b: Archetype["skeleton"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeChange(previous: Archetype["skeleton"] | null, next: Archetype["skeleton"]): string {
  if (!previous) return "first mine";

  const before = new Set(previous.sections.map((s) => s.role));
  const after = new Set(next.sections.map((s) => s.role));
  const added = [...after].filter((r) => !before.has(r));
  const removed = [...before].filter((r) => !after.has(r));

  const parts: string[] = [];
  if (added.length > 0) parts.push(`sections added: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`sections dropped: ${removed.join(", ")}`);
  if (parts.length === 0) parts.push("prevalence shifted without changing the section set");
  return parts.join("; ");
}

export async function mineAndStore(
  category: string,
  options: { force?: boolean } = {},
): Promise<PersistResult> {
  const archetype = await mineArchetype(category);
  if (!archetype) {
    return { category, version: null, stored: false, reason: "no labelled skills", archetype: null };
  }

  if (!archetype.meetsGate && !options.force) {
    // Not an error. R3.2's threshold exists so an archetype cannot be built from too little
    // or too narrow evidence, and refusing is the threshold working.
    return {
      category,
      version: null,
      stored: false,
      reason: `below the evidence gate — ${archetype.gateReason}`,
      archetype,
    };
  }

  const [previous] = await db
    .select({
      version: archetypes.version,
      skeleton: archetypes.skeleton,
    })
    .from(archetypes)
    .where(and(eq(archetypes.axis, "function"), eq(archetypes.category, category)))
    .orderBy(desc(archetypes.version))
    .limit(1);

  if (previous && skeletonsMatch(previous.skeleton, archetype.skeleton)) {
    return {
      category,
      version: previous.version,
      stored: false,
      reason: "unchanged since the last version",
      archetype,
    };
  }

  const version = (previous?.version ?? 0) + 1;
  const changelog = describeChange(
    (previous?.skeleton as Archetype["skeleton"] | undefined) ?? null,
    archetype.skeleton,
  );

  await db.transaction(async (tx) => {
    await tx.insert(archetypes).values({
      axis: "function",
      category,
      version,
      skeleton: archetype.skeleton,
      stats: {
        strongThreshold: archetype.strongThreshold,
        weakThreshold: archetype.weakThreshold,
        sections: archetype.skeleton.sections,
        traits: archetype.skeleton.traits,
      },
      antiPatterns: archetype.antiPatterns,
      exemplarSkillIds: archetype.exemplars.map((e) => e.skillId),
      skillCount: archetype.skillCount,
      distinctStructures: archetype.distinctStructures,
      sourceCount: archetype.sourceCount,
      strongThreshold: archetype.strongThreshold,
      weakThreshold: archetype.weakThreshold,
      extractorVersion: EXTRACTOR_VERSION,
      minerVersion: MINER_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
      changelog,
    });

    await tx.insert(events).values({
      actorType: "system",
      actorId: "analytics.archetype",
      kind: "archetype.mined",
      subjectType: "archetypes",
      reason: changelog,
      payload: {
        category,
        version,
        distinctStructures: archetype.distinctStructures,
        sourceCount: archetype.sourceCount,
        sections: archetype.skeleton.sections.length,
        antiPatterns: archetype.antiPatterns.length,
      },
    });
  });

  return { category, version, stored: true, reason: changelog, archetype };
}

/** Mines every function category. Free — no model, all from stored fingerprints. */
export async function mineAll(
  options: { force?: boolean; onProgress?: (m: string) => void } = {},
): Promise<PersistResult[]> {
  const log = options.onProgress ?? (() => {});
  const results: PersistResult[] = [];

  for (const fn of FUNCTIONS) {
    log(`mining ${fn.id}`);
    results.push(await mineAndStore(fn.id, options));
  }

  return results;
}

/** The current archetype for a category, or null when none has cleared the gate. */
export async function currentArchetype(category: string) {
  const [row] = await db
    .select()
    .from(archetypes)
    .where(and(eq(archetypes.axis, "function"), eq(archetypes.category, category)))
    .orderBy(desc(archetypes.version))
    .limit(1);
  return row ?? null;
}

/** Every category's latest archetype, for the settings panel. */
export async function archetypeSummary() {
  const rows = await db
    .select({
      category: archetypes.category,
      version: archetypes.version,
      skillCount: archetypes.skillCount,
      distinctStructures: archetypes.distinctStructures,
      sourceCount: archetypes.sourceCount,
      skeleton: archetypes.skeleton,
      antiPatterns: archetypes.antiPatterns,
      createdAt: archetypes.createdAt,
    })
    .from(archetypes)
    .orderBy(archetypes.category, desc(archetypes.version));

  // One row per category — the newest. Done here rather than with DISTINCT ON so the
  // ordering stays obvious to the next reader.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.category)) latest.set(row.category, row);
  return [...latest.values()];
}
