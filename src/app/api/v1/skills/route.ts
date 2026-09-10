import { apiPageSize } from "@/lib/api";
import { apiListSkills, envelope } from "@/server/api/public";

import { allowRead, ok } from "../_shared";

/**
 * `GET /api/v1/skills` — the corpus, filtered (Doc 2 R8.6, plan step F4).
 *
 * The registry's own query with the registry's own filters, so the API and the page cannot
 * disagree about what is servable. Every parameter here is one the sidebar already produces; the
 * difference is that a machine can send them all at once, which is exactly the gap R8.6 names
 * between a search box and structured input.
 */
export async function GET(request: Request): Promise<Response> {
  const refusal = await allowRead(request);
  if (refusal) return refusal;

  const params = new URL(request.url).searchParams;
  const page = await apiListSkills({
    query: params.get("q") ?? undefined,
    category: params.get("category") ?? undefined,
    capability: params.get("capability") ?? undefined,
    posture: params.get("licence") ?? undefined,
    dialect: params.get("dialect") ?? undefined,
    minQuality: params.get("min_quality") ? Number(params.get("min_quality")) : undefined,
    page: params.get("page") ? Number(params.get("page")) : undefined,
    pageSize: apiPageSize(params.get("page_size")) as 5 | 10 | 25,
  });

  return ok(
    envelope(page.items, { total: page.total, page: page.page, pageSize: page.pageSize }),
  );
}
