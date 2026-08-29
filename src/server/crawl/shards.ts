import "server-only";

/**
 * Partitioning the code-search space.
 *
 * GitHub returns at most 1,000 results per query however many exist, so any query with
 * more matches is unreadable past the first 1,000. The only way through is to split the
 * space into ranges small enough to fit under the cap.
 *
 * File size is the axis, because it is the one filter GitHub supports that is both
 * numeric (so it bisects cleanly) and roughly uniform across the corpus. Splitting on
 * `path:` or owner would need us to already know the distribution we are trying to
 * discover.
 *
 * The split is adaptive rather than a fixed grid: a shard is read, and only if GitHub
 * says it holds more than the cap is it bisected. A fixed grid either wastes requests on
 * empty ranges or leaves dense ones truncated, and requests are the scarce resource here
 * at ~10 per minute.
 */

/** GitHub's hard ceiling on results per query. */
export const RESULT_CAP = 1000;
/** Results per page; 100 is the maximum, so 10 pages reaches the cap. */
export const PAGE_SIZE = 100;
export const MAX_PAGES = RESULT_CAP / PAGE_SIZE;

export type SizeBounds = {
  /** Inclusive lower bound in bytes. */
  min: number;
  /** Exclusive upper bound in bytes; null means "no upper limit". */
  max: number | null;
};

/** The marker filename this crawl looks for. */
export const MARKER = "SKILL.md";

export function queryFor(bounds: SizeBounds): string {
  const size =
    bounds.max === null ? `size:>=${bounds.min}` : `size:${bounds.min}..${bounds.max - 1}`;
  return `filename:${MARKER} ${size}`;
}

/**
 * The starting partition.
 *
 * Deliberately uneven: skill markers cluster heavily in the low kilobytes, so the small
 * ranges are narrow and the large ones wide. Starting with an even split would saturate
 * every small shard immediately and waste a bisection round on each.
 */
export function seedBounds(): SizeBounds[] {
  const edges = [
    0, 256, 512, 768, 1024, 1536, 2048, 2560, 3072, 4096, 5120, 6144, 8192, 10240, 12288,
    16384, 24576, 32768, 65536,
  ];
  const bounds: SizeBounds[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    bounds.push({ min: edges[i], max: edges[i + 1] });
  }
  bounds.push({ min: edges[edges.length - 1], max: null });
  return bounds;
}

/**
 * Bisects a saturated range.
 *
 * Returns an empty array when the range can no longer be split — a single byte-size with
 * more than 1,000 matches. That is a real limit of this axis, not an error: the shard
 * stays `saturated`, which is exactly the signal that part of the space is unreadable
 * this way and needs a different filter.
 */
export function splitBounds(bounds: SizeBounds): SizeBounds[] {
  if (bounds.max === null) {
    // Open-ended: cut at double the lower bound and keep the tail open.
    const mid = Math.max(bounds.min + 1, bounds.min * 2);
    return [
      { min: bounds.min, max: mid },
      { min: mid, max: null },
    ];
  }

  const width = bounds.max - bounds.min;
  if (width <= 1) return [];

  const mid = bounds.min + Math.floor(width / 2);
  return [
    { min: bounds.min, max: mid },
    { min: mid, max: bounds.max },
  ];
}

export function boundsFromJson(value: unknown): SizeBounds {
  const record = (value ?? {}) as { min?: unknown; max?: unknown };
  return {
    min: typeof record.min === "number" ? record.min : 0,
    max: typeof record.max === "number" ? record.max : null,
  };
}

export function describeBounds(bounds: SizeBounds): string {
  return bounds.max === null ? `${bounds.min}+ bytes` : `${bounds.min}–${bounds.max - 1} bytes`;
}
