import { exportDraft } from "@/server/builder/export";
import type { DialectId } from "@/lib/dialects";

/**
 * Draft export (Doc 2 R4.4).
 *
 * A route handler for the same reason the corpus download is one: a file download cannot be
 * a server component (which renders HTML) or a server action (which returns a serialisable
 * value). This is the exception the "no database in API routes" rule anticipates — and it
 * stays within it. The route imports `@/server/builder/export`, touches no `@/server/db`,
 * `drizzle-orm` or `pg`, and scope is resolved in the DAL exactly as everywhere else.
 *
 * **Unlike the corpus download, this is not public.** Drafts are org-scoped with a NOT NULL
 * `org_id` and an RLS policy that has no `IS NULL` case, so a request with no session
 * resolves no draft at all. There is no separate permission check here because there is
 * nothing for one to add: the database is the boundary, and an id from another workspace
 * returns 404 rather than 403 — which is also the right thing to leak.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // `?dialect=` repeated, defaulting to the Agent Skills standard. A caller asking for a
  // format we do not render gets an empty selection and a 400, not a silently different one.
  const requested = new URL(request.url).searchParams.getAll("dialect");
  const dialects = (requested.length > 0
    ? requested
    : ["anthropic_skill"]) as DialectId[];

  const result = await exportDraft(id, dialects);

  if (!result.ok) {
    const status = result.message === "Draft not found." ? 404 : 400;
    return Response.json({ error: result.message }, { status });
  }

  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${result.filename}"`,
      "content-length": String(result.bytes.byteLength),
      // A draft changes when its author regenerates it, so unlike a content-addressed
      // corpus bundle this must never be cached.
      "cache-control": "no-store",
      "x-draft-content-hash": result.contentHash,
    },
  });
}
