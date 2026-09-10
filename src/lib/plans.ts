/**
 * Plans, features, and the surfaces that can never be sold (Doc 2 RC.1, Doc 1 §5).
 *
 * A leaf module with no imports, like `quality.ts` and `tokens.ts`: the gate, the admin
 * panel and the reference page all need one vocabulary, and a paywall whose definition
 * drifts from its explanation is a trust problem rather than a bug.
 *
 * ## The important half is `FREE_FOREVER`, not the plans
 *
 * RC.1's actual requirement is not "support tiers". It is that the free-tier trust surfaces
 * — per-skill verdicts, provenance, quarantine status, licence posture — are **hard-coded
 * exempt from gating and cannot be paywalled by configuration**. Doc 1 states the same
 * commitment in stronger words: paywalling the per-skill verdict would destroy the
 * platform's reason to exist.
 *
 * A comment saying "we would never gate this" is not a mechanism. So the exemption is
 * enforced by making the question unaskable: `hasEntitlement` and `requireEntitlement`
 * **throw** when handed one of these keys. Not "return true" — throw, loudly, as a
 * programming error. Returning true would let a caller wrap a trust surface in a gate that
 * quietly does nothing today and starts working the moment somebody "fixes" the special
 * case. Refusing the question means the wrong code cannot be written in the first place,
 * and `verify:entitlements` asserts every one of these keys still throws.
 */

export const PLANS = ["free", "pro", "team"] as const;

export type Plan = (typeof PLANS)[number];

/** The plan an organisation has when nothing says otherwise. */
export const DEFAULT_PLAN: Plan = "free";

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/**
 * Everything a plan can unlock.
 *
 * Each key names a capability that does not exist yet, and that is deliberate rather than
 * speculative: the plan steps that build them (C4 Distill, D the Eval Lab, RM.3 MCP
 * create-skill) are each blocked on there being an entitlement to check, so the keys land
 * first and the features arrive against them. What is **not** here is anything a reader can
 * see today — nothing currently served is gated, which is why the free-tier guarantee holds
 * by construction as well as by policy.
 */
export const FEATURES = [
  /** RW.5 Distill mode: derive a skill from transcripts and documents. Plan step C4. */
  "distill",
  /** RW.6–RW.8 the Eval Lab: skill CI, golden tasks, the with/without matrix. Plan step D. */
  "eval-lab",
  /** RW.8 the full trigger-precision lab. The quick check stays free. Plan step D2. */
  "trigger-lab-full",
  /** RM.3 scaffolding a draft from inside an agent session. */
  "mcp-create-skill",
  /** The higher MCP rate-limit scope. The only feature with a live call site today. */
  "mcp-elevated-limits",
  /** R4.7 draft version history and fork-with-attribution. */
  "version-history",
  /** RK.4 org convention blocks, referenced by many skills. Team. */
  "shared-blocks",
  /** RK.7 per-skill and per-org install, trigger and eval analytics. Team. */
  "impact-analytics",
  /** R1.9 private tenant sources and an org-scoped corpus. Team. */
  "private-corpus",
  /**
   * RK.8 facilitated expertise-capture programmes. Team.
   *
   * Doc 6 calls this **Enterprise**, and there is no enterprise tier — `PLANS` has three and
   * `team` is the top of them. Adding a fourth is a pricing decision with a page and a contract
   * behind it, not a code change, so this sits on the highest tier that exists and the mismatch
   * is written down rather than resolved by inventing a plan nobody has agreed to sell.
   */
  "capture-campaigns",
] as const;

export type Feature = (typeof FEATURES)[number];

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}

/**
 * Surfaces that are free on every plan, for ever, and are **not** expressible as features.
 *
 * These are the strings a future contributor would reach for when asked to "gate the
 * verdicts". Passing any of them to the entitlement gate throws, so the request fails at
 * the first attempt rather than shipping as a config flag nobody audits.
 *
 * Doc 1 §4.2 and RC.1 both list them; this is the list, in code, where it can be tested.
 */
export const FREE_FOREVER = [
  /** Per-skill validation verdicts with analyzer versions and evidence. */
  "verdicts",
  /** Source, author, licence, commit, hashes (R1.3, G5). */
  "provenance",
  /** Why a skill was quarantined, and that it was. */
  "quarantine-status",
  /** What a skill may reach: filesystem, network, shell, credentials (R2.4). */
  "capability-surface",
  /** The composite score and its sub-scores (R2.9). */
  "quality-score",
  /** Licence posture and whether the bytes may be served (R1.6). */
  "licence-posture",
  /** Reading and searching the public registry without an account (R8.1). */
  "public-registry",
  /** Downloading a skill whose licence permits it (R8.2). */
  "download",
  /**
   * Who has endorsed a skill, and that nobody has (RK.6).
   *
   * It belongs on this list for the same reason the verdicts do: it is a **trust surface**, and
   * a reader deciding whether to run somebody else's instructions must be able to see the whole
   * of what we know. Selling it would be worse than selling a verdict, because the absence is
   * the part that matters most — "no maintainer has looked at this" behind a paywall is a
   * registry that shows its good news for free and charges for the warning.
   *
   * *Endorsing* is a maintainer's right rather than a plan feature, so there is nothing to gate
   * on the write side either.
   */
  "endorsements",
] as const;

export type FreeForever = (typeof FREE_FOREVER)[number];

export function isFreeForever(value: unknown): value is FreeForever {
  return typeof value === "string" && (FREE_FOREVER as readonly string[]).includes(value);
}

/**
 * What each plan includes. Cumulative in practice, but written out rather than layered.
 *
 * Spelled out per plan on purpose: a `pro = [...free, "x"]` chain reads well and makes it
 * impossible to see at a glance what a Team customer actually gets, which is the question
 * an admin panel and a pricing page both have to answer.
 */
export const PLAN_FEATURES: Record<Plan, readonly Feature[]> = {
  free: [],
  pro: [
    "distill",
    "eval-lab",
    "trigger-lab-full",
    "mcp-create-skill",
    "mcp-elevated-limits",
    "version-history",
  ],
  team: [
    "distill",
    "eval-lab",
    "trigger-lab-full",
    "mcp-create-skill",
    "mcp-elevated-limits",
    "version-history",
    "shared-blocks",
    "impact-analytics",
    "capture-campaigns",
    "private-corpus",
  ],
};

export const PLAN_META: Record<Plan, { label: string; blurb: string }> = {
  free: {
    label: "Free",
    blurb:
      "The whole trust surface, the public registry, downloads, and authoring with a fair-use quota.",
  },
  pro: {
    label: "Pro",
    blurb: "Private drafts, the Eval Lab, Distill mode, and authoring from inside an agent.",
  },
  team: {
    label: "Team",
    blurb: "A private corpus, shared convention blocks, and impact analytics across the org.",
  },
};

export const FEATURE_META: Record<Feature, { label: string; blurb: string }> = {
  distill: { label: "Distill mode", blurb: "Build a skill from transcripts, docs and diffs." },
  "eval-lab": { label: "Eval Lab", blurb: "Golden tasks, skill CI, and the with/without matrix." },
  "trigger-lab-full": {
    label: "Trigger lab",
    blurb: "Full precision, recall and collision testing. The quick check is free.",
  },
  "mcp-create-skill": {
    label: "Author over MCP",
    blurb: "Scaffold and draft a skill from inside an agent session.",
  },
  "mcp-elevated-limits": {
    label: "Higher MCP limits",
    blurb: "The elevated request scope for programmatic access.",
  },
  "version-history": {
    label: "Version history",
    blurb: "Draft history, diffs, and fork-with-attribution.",
  },
  "shared-blocks": {
    label: "Shared blocks",
    blurb: "Define a convention once and reference it from many skills.",
  },
  "impact-analytics": {
    label: "Impact analytics",
    blurb: "Which of your skills actually get used, and what they cost.",
  },
  "capture-campaigns": {
    label: "Expertise capture",
    blurb:
      "A facilitated programme: a named list of what has to be captured before somebody rotates off, and Interview and Distill run against it.",
  },
  "private-corpus": {
    label: "Private corpus",
    blurb: "Internal sources through the same pipeline, never feeding public archetypes.",
  },
};

/** Pure lookup, no gate semantics. The gate lives in the DAL and adds the refusals. */
export function planIncludes(plan: Plan, feature: Feature): boolean {
  return PLAN_FEATURES[plan].includes(feature);
}

/** The cheapest plan that includes a feature, for an upgrade prompt. */
export function lowestPlanFor(feature: Feature): Plan | null {
  return PLANS.find((plan) => planIncludes(plan, feature)) ?? null;
}
