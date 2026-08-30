import { exportSkill } from "@/server/skills/export";

/**
 * Skill download (Doc 2 R8.2).
 *
 * ## Why this is a route handler and not a server action
 *
 * The repo rule is that queries live in `src/server/**` and are called from server
 * components and server actions, and that route handlers get no database. Both hold here:
 * this file touches no database, no `drizzle-orm`, no `pg`. It calls `exportSkill`, which
 * is `server-only` and reads through the DAL, so scope is still resolved where the rule
 * requires it — `withOrgScope` decides what is visible, and RLS backs that decision.
 *
 * A route handler is used because a file download genuinely cannot be anything else: a
 * server component renders HTML and a server action returns a serialisable value, neither
 * of which can stream an archive with `Content-Disposition`. This is the exception the rule
 * anticipates, not a way around it — which is why the reasoning is written down rather than
 * left for someone to rediscover.
 *
 * ## Public, like the pages
 *
 * No session check. Anything servable is public-corpus content whose licence permits
 * redistribution; the export path itself refuses everything else — a quarantined skill, an
 * unresolved licence, a metadata-only skill — before any object is read. Gating downloads
 * behind an account would gate exactly the artifacts the verdicts exist to vouch for.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const result = await exportSkill(slug);

  if (!result.ok) {
    const status =
      result.reason === "not-found" ? 404 : result.reason === "not-licensed" ? 451 : 409;

    // JSON rather than a redirect to origin: a client asked us for bytes, and silently
    // bouncing it somewhere else would look like a successful download of something we
    // never validated. The origin is offered as data for the caller to act on.
    return Response.json(
      { error: result.reason, message: result.message, origin: result.originUrl ?? null },
      { status },
    );
  }

  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "content-length": String(result.bytes.byteLength),
      // The bundle at a content hash is immutable by construction, so it can be cached
      // hard. A new version of the skill is a different hash and a different download.
      "cache-control": "public, max-age=3600",
      // Lets a consumer verify what they received without opening the archive (R2.6).
      "x-skill-content-hash": result.contentHash,
      "x-skill-report-hash": result.reportHash,
      "x-skill-license": result.licenseSpdx ?? "unresolved",
    },
  });
}
