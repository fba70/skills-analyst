/**
 * What a licence posture permits, in one place.
 *
 * A leaf module with no imports, like `quality.ts`, `tokens.ts` and `block-types.ts`. It exists
 * because the same two-element set had grown **three** independent definitions — `mayMirror` in
 * `server/storage`, `QUOTABLE` in the block library, and a third in the C6 importer — each
 * spelled out by hand next to the code that needed it.
 *
 * Three copies of a rule about *what may be legally copied* is worse than three copies of most
 * things. They cannot drift in a way a type checker notices, they are read by people making a
 * decision about somebody else's rights, and the day one of them gains a posture the others do
 * not is the day the platform copies bytes one of its own modules would have refused.
 *
 * So: one list, and everything imports it. The direction of dependency is what makes a fourth
 * copy impossible rather than merely discouraged — the same argument `block-types.ts` makes about
 * being the canonical vocabulary its `server-only` detector imports.
 */

/**
 * Postures whose bytes may be copied.
 *
 * `metadata_only` is a licence that permits analysis and not redistribution; `unresolved` means
 * we looked and could not tell, and is treated as `metadata_only` until it is resolved — a
 * missing answer is not permission.
 */
export const REDISTRIBUTABLE = ["mirror_allowed", "attribution_required"] as const;

export type RedistributablePosture = (typeof REDISTRIBUTABLE)[number];

export function isRedistributable(posture: unknown): posture is RedistributablePosture {
  return typeof posture === "string" && (REDISTRIBUTABLE as readonly string[]).includes(posture);
}

/**
 * The posture that additionally requires the credit to be rendered wherever the bytes appear.
 *
 * Named rather than inlined, because two things key off it and they are in different layers:
 * `exportSkill` writes `ATTRIBUTION.txt` into the archive, and a fork published from a draft
 * inherits the posture so that it keeps doing so.
 */
export const ATTRIBUTION_POSTURE = "attribution_required" as const;
