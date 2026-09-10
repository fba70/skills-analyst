import { apiResolve, envelope } from "@/server/api/public";

import { allowRead, fail, ok } from "../../../_shared";

/**
 * `GET /api/v1/skills/{slug}/resolve` — hosted resolution (Doc 2 R8.3, plan step F4).
 *
 * A name in, a pinned version out, in the shape a package runner expects. The **content hash** is
 * the point: it is the same hash the verdict covers and the storage key is derived from, so a
 * consumer can check what they received against what we said without trusting us.
 *
 * A near-duplicate resolves to its canonical entry, and says which name was asked for — an agent
 * requesting one of sixty copies should get the one the registry maintains.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const refusal = await allowRead(request);
  if (refusal) return refusal;

  const { slug } = await context.params;
  const result = await apiResolve(slug);
  if (!result.ok) {
    return result.error === "gone"
      ? fail("gone", "This skill was withdrawn following a request.")
      : fail("not-found", "No such skill.");
  }
  return ok(envelope(result));
}
