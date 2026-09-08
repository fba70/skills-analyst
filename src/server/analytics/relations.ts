import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  isRelationKind,
  STORED_KINDS,
  type Relation,
  type RelationKind,
  type RelationSource,
} from "@/lib/relations";
import { db } from "@/server/db";
import { skillEmbeddings, skillRelations, skills } from "@/server/db/schema";
import { EMBEDDER_VERSION } from "@/server/analytics/embeddings";

/**
 * Reading the knowledge graph (Doc 6 RK.3, plan step E2).
 *
 * ## Four kinds, two of which are never stored
 *
 * `relationsFor` composes them so a caller does not have to know which is which:
 *
 * - **similar-to** — a `<=>` lookup against the A6 index. Free, and current by construction; a
 *   stored copy would be a snapshot that goes stale the moment a skill is re-embedded.
 * - **superseded-by / supersedes** — a live join on `skills.superseded_by_skill_id`, which is what A4 built
 *   so a replacement quarantined since stops being recommended rather than going on being
 *   suggested from a stored list.
 * - **conflicts-with** and **declared** — read from `skill_relations`, because a model call per
 *   pair and somebody's assertion are the two things that cannot be recomputed on a page load.
 *
 * ## Everything resolves through `indexed` skills only
 *
 * The same live filter archetype exemplars use, and for the same reason: an edge pointing at a
 * withdrawn or quarantined skill must stop being offered the moment that happens, not the next
 * time somebody re-mines. A relation to something a reader cannot open is worse than no relation
 * — it is a recommendation into a 404.
 */

export type RelationView = {
  relations: Relation[];
  /** Conflicts, separated because they are the only kind that is a warning. */
  conflicts: Relation[];
};

export async function relationsFor(
  skillId: string,
  options: { similarLimit?: number } = {},
): Promise<RelationView> {
  const [stored, supersession, similar] = await Promise.all([
    storedRelations(skillId),
    supersessionRelations(skillId),
    similarRelations(skillId, options.similarLimit ?? 5),
  ]);

  const all = [...stored, ...supersession, ...similar];
  return {
    relations: all.filter((relation) => relation.kind !== "conflicts-with"),
    conflicts: all.filter((relation) => relation.kind === "conflicts-with"),
  };
}

/** Just the conflicts, for the MCP warning — which must not pay for a similarity lookup. */
export async function conflictsFor(skillId: string): Promise<Relation[]> {
  return (await storedRelations(skillId)).filter(
    (relation) => relation.kind === "conflicts-with",
  );
}

/**
 * The same, by slug.
 *
 * `download_skill` has a slug and an `ExportBundle`, and the bundle carries no skill id — widening
 * that type for a warning would change the export contract to serve a display concern, and
 * `exportSkill`'s shape is load-bearing for R2.6's byte-identical receipt. One indexed lookup here
 * is the cheaper trade.
 */
export async function conflictsForSlug(slug: string): Promise<Relation[]> {
  const [row] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);
  return row ? conflictsFor(row.id) : [];
}

async function storedRelations(skillId: string): Promise<Relation[]> {
  const rows = await db
    .select({
      kind: skillRelations.kind,
      source: skillRelations.source,
      detail: skillRelations.detail,
      slug: skills.slug,
      name: skills.name,
    })
    .from(skillRelations)
    .innerJoin(skills, eq(skills.id, skillRelations.toSkillId))
    .where(
      and(
        eq(skillRelations.fromSkillId, skillId),
        /* Live, like an exemplar: an edge into a withdrawn skill stops being offered at once. */
        eq(skills.status, "indexed"),
      ),
    );

  return rows
    .filter((row) => isRelationKind(row.kind))
    .map((row) => ({
      kind: row.kind as RelationKind,
      source: (row.source === "mined" ? "mined" : "declared") as RelationSource,
      slug: row.slug,
      name: row.name,
      detail: row.detail,
      similarity: null,
    }));
}

/**
 * Supersession, read from where A4 put it.
 *
 * Both directions: the skill this one replaces, and the one that replaced it. The second is the
 * one a reader needs — arriving at a superseded skill, the useful fact is where to go instead —
 * and A4 already refuses to record it without a target, so there is no dangling case to handle.
 */
async function supersessionRelations(skillId: string): Promise<Relation[]> {
  const forward = await db
    .select({ slug: skills.slug, name: skills.name })
    .from(skills)
    .where(
      and(
        eq(
          skills.id,
          sql`(select superseded_by_skill_id from skills where id = ${skillId})`,
        ),
        eq(skills.status, "indexed"),
      ),
    )
    .limit(1);

  const backward = await db
    .select({ slug: skills.slug, name: skills.name })
    .from(skills)
    .where(and(eq(skills.supersededBySkillId, skillId), eq(skills.status, "indexed")))
    .limit(5);

  return [
    ...forward.map((row) => ({
      kind: "superseded-by" as const,
      source: "declared" as const,
      slug: row.slug,
      name: row.name,
      detail: null,
      similarity: null,
    })),
    ...backward.map((row) => ({
      kind: "supersedes" as const,
      source: "declared" as const,
      slug: row.slug,
      name: row.name,
      detail: null,
      similarity: null,
    })),
  ];
}

/**
 * Nearest neighbours, from the vector already stored for this skill.
 *
 * No embedding call: the skill's own vector is a row, so this is one `<=>` against an index that
 * exists. That is why `similar-to` is never stored — recomputing it costs nothing and a stored
 * copy could disagree with the index it came from.
 */
async function similarRelations(skillId: string, limit: number): Promise<Relation[]> {
  const result = await db.execute(sql`
    select s.slug, s.name, 1 - (e.embedding <=> mine.embedding) as similarity
    from ${skillEmbeddings} e
    join ${skills} s on s.id = e.skill_id
    join ${skillEmbeddings} mine on mine.skill_id = ${skillId}
      and mine.embedder_version = ${EMBEDDER_VERSION}
    where e.embedder_version = ${EMBEDDER_VERSION}
      and e.org_id is null
      and s.status = 'indexed'
      and s.canonical_skill_id is null
      and s.id <> ${skillId}
    order by e.embedding <=> mine.embedding
    limit ${limit}
  `);

  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    kind: "similar-to" as const,
    source: "mined" as const,
    slug: row.slug as string,
    name: row.name as string,
    detail: null,
    similarity: Math.round(Number(row.similarity) * 1000) / 1000,
  }));
}

export type DeclareRelationInput = {
  fromSkillId: string;
  toSkillId: string;
  kind: RelationKind;
  orgId: string | null;
  userId: string | null;
  detail?: string | null;
};

export type DeclareResult = { ok: true } | { ok: false; message: string };

/**
 * Record an author-declared edge.
 *
 * ## The derived kinds are refused, not silently ignored
 *
 * `similar-to` and `supersedes` have homes elsewhere, and a writer that accepted them would create
 * exactly the stale copy this module exists to avoid — a `similar-to` row frozen at whatever the
 * index said the day somebody clicked. Refusing names the alternative, so the caller learns where
 * the answer actually lives rather than that their input vanished.
 */
export async function declareRelation(input: DeclareRelationInput): Promise<DeclareResult> {
  if (!isRelationKind(input.kind)) return { ok: false, message: "Unknown relation." };
  if (!STORED_KINDS.includes(input.kind)) {
    return {
      ok: false,
      message:
        input.kind === "similar-to"
          ? "Similarity is measured from the embedding index, not declared."
          : "Supersession is declared with `pnpm lifecycle --supersede`, which keeps the live join.",
    };
  }
  if (input.fromSkillId === input.toSkillId) {
    return { ok: false, message: "A skill cannot relate to itself." };
  }

  await writeEdge(input, "declared", null);
  return { ok: true };
}

/**
 * Write one edge, and its mirror when the kind is symmetric.
 *
 * Both directions in one statement, so a conflict can never exist from one side only — which is
 * the shape that would make an install-time warning appear on one skill and not the other, and
 * would be invisible until somebody compared two pages.
 */
export async function writeEdge(
  input: DeclareRelationInput,
  source: RelationSource,
  minerVersion: string | null,
): Promise<void> {
  const { isSymmetric } = await import("@/lib/relations");
  const rows = [
    {
      orgId: input.orgId,
      fromSkillId: input.fromSkillId,
      toSkillId: input.toSkillId,
      kind: input.kind,
      source,
      detail: input.detail ?? null,
      minerVersion,
      createdBy: input.userId,
    },
  ];
  if (isSymmetric(input.kind)) {
    rows.push({ ...rows[0], fromSkillId: input.toSkillId, toSkillId: input.fromSkillId });
  }

  await db
    .insert(skillRelations)
    .values(rows)
    .onConflictDoUpdate({
      target: [skillRelations.fromSkillId, skillRelations.toSkillId, skillRelations.kind],
      set: { detail: input.detail ?? null, minerVersion, source },
    });
}

/** Counts for the CLI and the settings panel. */
export async function relationSummary() {
  const rows = await db
    .select({
      kind: skillRelations.kind,
      source: skillRelations.source,
      n: sql<number>`count(*)::int`,
    })
    .from(skillRelations)
    .where(isNull(skillRelations.orgId))
    .groupBy(skillRelations.kind, skillRelations.source);

  const [minerRow] = await db
    .select({
      current: sql<number>`count(*) filter (where ${skillRelations.minerVersion} = ${sql.placeholder("v")})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(skillRelations)
    .where(eq(skillRelations.source, "mined"))
    .prepare("relation_miner_counts")
    .execute({ v: (await import("@/lib/relations")).CONFLICT_MINER_VERSION });

  return { rows, mined: minerRow ?? { current: 0, total: 0 } };
}
