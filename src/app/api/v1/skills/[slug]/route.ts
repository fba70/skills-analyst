import { apiGetSkill, envelope } from "@/server/api/public";

import { allowRead, fail, ok } from "../../_shared";

/**
 * `GET /api/v1/skills/{slug}` — one skill's metadata and verdicts (R8.6, plan step F4).
 *
 * A withdrawn skill answers **410**, not 404. R8.4 wants citations to keep resolving, and a
 * silent 404 tells a reader nothing about whether the skill was dangerous, deleted or removed on
 * request — the same reasoning that keeps its page alive with grounds and a date.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const refusal = await allowRead(request);
  if (refusal) return refusal;

  const { slug } = await context.params;
  const result = await apiGetSkill(slug);
  if (!result.ok) {
    return result.error === "gone"
      ? fail("gone", "This skill was withdrawn following a request. Its page explains the grounds.")
      : fail("not-found", "No such skill.");
  }
  return ok(envelope(result.skill));
}
