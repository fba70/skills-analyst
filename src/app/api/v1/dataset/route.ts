import { DATASET_PAGE } from "@/lib/api";
import { apiDataset, envelope } from "@/server/api/public";

import { allowRead, ok } from "../_shared";

/**
 * `GET /api/v1/dataset` — the research export (Doc 2 R3.7, plan step F4).
 *
 * The offer Doc 1 makes to researchers: the corpus as data rather than as pages. **Metadata and
 * our derived analysis only — no skill text, at any volume.** That is not a limitation bolted on
 * afterwards; it is what makes a bulk endpoint possible at all, because `metadata_only` is
 * precisely the posture meaning *name it, describe it, link to it, do not hand over the bytes*.
 *
 * Cursor-paged on the slug rather than offset-paged. An offset silently skips or repeats rows
 * when the corpus grows underneath a long export, and this corpus grows on a schedule.
 */
export async function GET(request: Request): Promise<Response> {
  const refusal = await allowRead(request);
  if (refusal) return refusal;

  const params = new URL(request.url).searchParams;
  const page = await apiDataset(
    params.get("after"),
    params.get("limit") ? Number(params.get("limit")) : DATASET_PAGE,
  );

  return ok(
    envelope(page.records, {
      nextCursor: page.nextCursor,
      note:
        page.nextCursor === null
          ? "Complete."
          : `More records: repeat with ?after=${page.nextCursor}`,
    }),
  );
}
