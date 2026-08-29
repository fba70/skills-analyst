import "server-only";

import { createHash } from "node:crypto";

/**
 * Near-duplicate detection by MinHash + LSH (Doc 2 R1.4).
 *
 * Exact-hash dedup already collapses byte-identical bundles. This catches the other case,
 * which is most of the corpus: repositories that copy a skill and change a line. Those
 * have different content hashes and are the same skill.
 *
 * MinHash rather than embeddings, deliberately. The duplication here is *lexical* — text
 * copied nearly verbatim — which MinHash estimates directly, deterministically, and for
 * free. Embeddings answer a different question (semantic similarity) at a cost per skill,
 * and that question belongs to categorisation, not dedup.
 *
 * The estimate is unbiased: the probability that two sets share a given minimum equals
 * their Jaccard similarity, so averaging over K permutations approximates it with error
 * ~1/sqrt(K).
 */

/** Permutations in a signature. 128 gives ~9% standard error — ample for a 0.9 cut-off. */
export const SIGNATURE_SIZE = 128;

/**
 * Bands for LSH. 32 bands of 4 rows makes two documents candidates when any band matches
 * exactly, with detection probability 1-(1-s^4)^32 — about 0.98 at s=0.9 and 0.09 at
 * s=0.4. Fewer, wider bands would miss real duplicates; more would flood the verify step.
 */
export const BAND_COUNT = 32;
export const BAND_ROWS = SIGNATURE_SIZE / BAND_COUNT;

/** Word count per shingle. 5 is long enough that common phrasing does not collide. */
const SHINGLE_WORDS = 5;

const MERSENNE_PRIME = 2n ** 61n - 1n;

/**
 * Text to compare: prose only.
 *
 * Frontmatter, code blocks and links are stripped because they are the parts that differ
 * for uninteresting reasons — a copied skill with a renamed script is still the same
 * skill. Case and whitespace are normalised for the same reason.
 */
export function normalizeForComparison(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Overlapping word n-grams. Order matters, which is what makes copying detectable. */
export function shingles(text: string, size = SHINGLE_WORDS): Set<string> {
  const words = text.split(" ").filter(Boolean);
  const set = new Set<string>();

  if (words.length < size) {
    if (words.length > 0) set.add(words.join(" "));
    return set;
  }

  for (let i = 0; i + size <= words.length; i += 1) {
    set.add(words.slice(i, i + size).join(" "));
  }
  return set;
}

function hash64(value: string): bigint {
  const digest = createHash("sha1").update(value).digest();
  return digest.readBigUInt64BE(0) % MERSENNE_PRIME;
}

/**
 * Coefficients for the permutation family h_i(x) = (a_i*x + b_i) mod p.
 *
 * Fixed, not random: two runs must produce comparable signatures, or a rebuild silently
 * invalidates every stored signature. Derived from the index so they need no storage.
 */
function coefficients(index: number): { a: bigint; b: bigint } {
  return {
    a: (hash64(`minhash-a-${index}`) % (MERSENNE_PRIME - 1n)) + 1n,
    b: hash64(`minhash-b-${index}`) % MERSENNE_PRIME,
  };
}

const COEFFICIENTS = Array.from({ length: SIGNATURE_SIZE }, (_, i) => coefficients(i));

/** The MinHash signature: the smallest hash under each permutation. */
export function minhashSignature(shingleSet: Set<string>): number[] {
  const signature = new Array<bigint>(SIGNATURE_SIZE).fill(MERSENNE_PRIME);

  for (const shingle of shingleSet) {
    const value = hash64(shingle);
    for (let i = 0; i < SIGNATURE_SIZE; i += 1) {
      const { a, b } = COEFFICIENTS[i];
      const permuted = (a * value + b) % MERSENNE_PRIME;
      if (permuted < signature[i]) signature[i] = permuted;
    }
  }

  // Stored as int4: the low 32 bits keep enough entropy for band equality and comparison.
  return signature.map((value) => Number(BigInt.asIntN(32, value)));
}

/** Estimated Jaccard similarity: the fraction of positions two signatures agree on. */
export function estimateSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / a.length;
}

/** Exact Jaccard, for confirming a candidate pair rather than estimating it. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Band hashes for LSH.
 *
 * Two documents become candidates when any band hashes identically, which turns
 * similarity search into an equality join — the only shape that stays workable at
 * 500K skills, where all-pairs comparison is 125 billion pairs.
 */
export function bandHashes(signature: number[]): string[] {
  const bands: string[] = [];
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const slice = signature.slice(band * BAND_ROWS, (band + 1) * BAND_ROWS);
    bands.push(createHash("sha1").update(`${band}:${slice.join(",")}`).digest("hex").slice(0, 16));
  }
  return bands;
}
