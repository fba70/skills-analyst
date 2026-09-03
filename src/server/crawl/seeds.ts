import "server-only";

/**
 * The curated seed allow-list (Doc 4 §4 step 1).
 *
 * ## Why this exists at all
 *
 * The code-search crawl is a *complete enumeration* strategy: it shards `filename:SKILL.md`
 * by file size and reads the space range by range. Two things went wrong with relying on it
 * alone, and both are measured rather than suspected:
 *
 *   - **It cannot finish.** GitHub reports 381,952 SKILL.md files. 38 of our shards are
 *     `saturated` — over the 1,000-result cap and no longer splittable on the size axis —
 *     covering 383,662 reported results that are unreachable this way. We have read ~4,000
 *     markers, roughly 1%.
 *   - **It has no notion of value.** Byte-size ranges are arbitrary with respect to
 *     quality, so the corpus filled with whatever happened to sit in the ranges read first:
 *     one repository supplied 89% of it, while `garrytan/gstack` — 130k stars, MIT, 68
 *     markers, updated the same week — was never reached.
 *
 * A hand-picked list fixes the second problem immediately and cheaply. The curation *is*
 * the ranking signal the crawl structurally cannot produce.
 *
 * ## Every entry here was verified, not remembered
 *
 * Marker counts below were read from the GitHub tree API at the time of writing. They are
 * recorded as documentation, not as a constraint — the seed runner re-reads each repository
 * and reports what it actually finds, so a count that has drifted is visible rather than
 * assumed. Entries that resolved to zero markers (`netlify/netlify-mcp`) or did not exist
 * (`figma/figma-skills`, `googlelabs/skills`) were dropped rather than left in hopefully.
 *
 * ## This is policy, and policy becomes data
 *
 * Same standing note as `policy.ts`: these belong in the settings table with an admin UI,
 * so adding a source is not a redeploy. `pnpm submit` and Settings → Add source already
 * cover the one-off case; this list is the reproducible baseline a fresh environment starts
 * from.
 */

export type SeedRepo = {
  /** `owner/name` on github.com. */
  readonly repo: string;
  /** Why it is on the list — recorded as provenance on the discovered_repos row. */
  readonly note: string;
  /** Markers counted at verification time. Documentation; the runner re-reads. */
  readonly markersAtVerification: number;
  /** Narrow a large repository to the directories that hold skills. */
  readonly includePaths?: readonly string[];
  /**
   * Enter as a candidate for review instead of promoting.
   *
   * For repositories that are worth having and big enough to unbalance the corpus on their
   * own. `davila7/claude-code-templates` (898 markers) and `alirezarezvani/claude-skills`
   * (857) would each be roughly a third of the corpus — the same failure that
   * `mohitagw15856/pm-claude-skills` already caused once, arriving through the front door
   * this time. Holding them is a curator's call about *when*, not a judgement that the
   * content is bad; the flag records it declaratively so nobody has to remember to undo an
   * auto-promotion by hand afterwards.
   */
  readonly holdForReview?: boolean;
};

/**
 * **Origin repos** — first-party and high-trust community packs (Doc 4 §2, class 1).
 *
 * Ordered roughly by trust: vendor repos first, then the community packs that the awesome
 * lists themselves converge on.
 */
export const SEED_REPOS: readonly SeedRepo[] = [
  // ---- First-party vendor repos -----------------------------------------
  { repo: "anthropics/skills", note: "Anthropic, official skills", markersAtVerification: 21 },
  {
    repo: "anthropics/claude-code",
    note: "Anthropic, Claude Code's own bundled skills",
    markersAtVerification: 10,
  },
  {
    repo: "vercel-labs/agent-skills",
    note: "Vercel Labs, agent skills",
    markersAtVerification: 15,
  },
  { repo: "vercel-labs/skills", note: "Vercel Labs, skills", markersAtVerification: 2 },
  { repo: "stripe/ai", note: "Stripe, agent toolkit (was stripe/agent-toolkit)", markersAtVerification: 48 },
  { repo: "cloudflare/agents", note: "Cloudflare, agents SDK skills", markersAtVerification: 21 },
  { repo: "getsentry/skills", note: "Sentry (was getsentry/sentry-skills)", markersAtVerification: 37 },
  { repo: "trailofbits/skills", note: "Trail of Bits, security skills", markersAtVerification: 92 },
  { repo: "huggingface/skills", note: "Hugging Face", markersAtVerification: 27 },
  { repo: "expo/expo", note: "Expo, mobile tooling", markersAtVerification: 9 },

  // ---- High-signal community packs ---------------------------------------
  {
    repo: "garrytan/gstack",
    note: "gstack — 130k stars, MIT; the repo the size-sharded crawl never reached",
    markersAtVerification: 68,
  },
  { repo: "obra/superpowers", note: "superpowers, named in Doc 4 §4", markersAtVerification: 16 },
  {
    repo: "wshobson/agents",
    note: "large community agent/skill collection",
    markersAtVerification: 183,
  },
  {
    repo: "mattpocock/skills",
    note: "Matt Pocock — targeted fixes for common agent failure modes",
    markersAtVerification: 40,
  },
  {
    repo: "aws/agent-toolkit-for-aws",
    note: "AWS, official agent toolkit skills",
    markersAtVerification: 156,
  },
  {
    repo: "multica-ai/andrej-karpathy-skills",
    note: "Karpathy calibration guidelines — one skill, but a heavily referenced one; no licence declared, so metadata-only",
    markersAtVerification: 1,
  },

  // ---- Large collections -------------------------------------------------
  //
  // Admitted deliberately, and the reasoning is worth stating because it reverses an
  // earlier decision. These were briefly held for being big enough to dominate the corpus.
  // That was the wrong test. Source concentration is a *proxy*; the thing that actually
  // damages the foundry is structural monoculture — many skills sharing one skeleton — and
  // a repository can be large and structurally diverse, or small and entirely cloned.
  // `templateClusters()` in `analytics/templates.ts` measures the real property.
  //
  // Volume is also an asset at this stage, not just a cost: categorisation and archetype
  // mining need mass to find signal in, and a corpus curated down to only pristine sources
  // would have too little to learn from. Noise is acceptable input; what matters is that
  // nothing skips dedup, validation or classification on the way in — and nothing does.
  {
    repo: "davila7/claude-code-templates",
    note: "very large template collection — admitted for volume; watch its template-cluster ratio",
    markersAtVerification: 909,
  },
  {
    repo: "alirezarezvani/claude-skills",
    note: "380+ skills across engineering, marketing, product, compliance",
    markersAtVerification: 857,
  },

  // ---- First-party vendor repos, second wave -----------------------------
  //
  // Added 2026-09-03, and the reason is a measurement rather than a preference.
  //
  // This list *is* the strong band archetype mining contrasts against — `CURATED_SOURCES`
  // in `analytics/archetype.ts` derives from it. Written in August against a 16k corpus, it
  // held 18 repos. Sync then finished and the corpus reached 49,258 indexed skills, of which
  // the 18 supplied **865 — 1.8%**. Everything else, by construction, was the weak band.
  //
  // Meanwhile the skills.sh reconciliation brought in 2,323 repositories, and among them
  // sat the first-party vendor repos this section exists to name: NVIDIA, Google, Adobe,
  // Salesforce, Microsoft, OpenAI, Grafana, Elastic, HashiCorp — 27 of them holding 1,987
  // indexed skills, 2.3x the whole strong band, all counted as weak.
  //
  // The decisive tell was the same organisation appearing on both sides of the contrast:
  // `getsentry/skills` curated but `getsentry/sentry-for-ai` not, `anthropics/skills`
  // curated but `anthropics/knowledge-work-plugins` — ten times larger — not. A contrast
  // like that is not measuring craft. It is measuring which URLs somebody typed in August,
  // and every `lift` in archetype v5 was diluted by exactly that.
  //
  // ## The rule applied here
  //
  // **First-party: the GitHub organisation owns the product the skills document.** That is
  // checkable from the org rather than being a quality opinion, and it is the same
  // judgement the vendor section above already made — this only applies it to the
  // repositories that arrived after it was written. Stars are not a criterion: `celigo/ai`
  // has three and `sumsub/agent-skills` six, and both are a vendor documenting its own
  // product for agents, which is the craft signal the band is a proxy for. Popularity
  // getting no vote is the same rule R2.9 applies to search ranking.
  //
  // Notable individuals — `antfu`, `addyosmani`, `chrisbanes` — are deliberately NOT here.
  // That is the "high-signal community" class one section up, a different rule, and mixing
  // the two in one pass would leave the band with no statable definition.
  //
  // Marker counts read from the GitHub tree API on 2026-09-03. All 51 resolved; none was
  // added from memory.
  { repo: "NVIDIA/skills", note: "NVIDIA, first-party", markersAtVerification: 348 },
  { repo: "google/skills", note: "Google, first-party", markersAtVerification: 133 },
  { repo: "google/mantis", note: "Google, first-party", markersAtVerification: 22 },
  { repo: "google/adk-kotlin", note: "Google, ADK for Kotlin", markersAtVerification: 16 },
  { repo: "android/skills", note: "Android (Google), first-party", markersAtVerification: 22 },
  { repo: "microsoft/azure-skills", note: "Microsoft, Azure", markersAtVerification: 79 },
  { repo: "microsoft/apm", note: "Microsoft, APM", markersAtVerification: 74 },
  { repo: "microsoft/fluentui", note: "Microsoft, Fluent UI — product repo shipping its own skills", markersAtVerification: 25 },
  { repo: "openai/skills", note: "OpenAI, first-party", markersAtVerification: 44 },
  {
    repo: "aliyun/alibabacloud-aiops-skills",
    note: "Alibaba Cloud, AIOps",
    markersAtVerification: 313,
  },
  { repo: "openshift-eng/ai-helpers", note: "Red Hat, OpenShift engineering", markersAtVerification: 116 },
  { repo: "hashicorp/agent-skills", note: "HashiCorp, first-party", markersAtVerification: 21 },
  { repo: "elastic/agent-skills", note: "Elastic, first-party", markersAtVerification: 72 },
  { repo: "grafana/skills", note: "Grafana Labs, first-party", markersAtVerification: 52 },

  // Anthropic's own, beyond `anthropics/skills` and `anthropics/claude-code` above.
  {
    repo: "anthropics/knowledge-work-plugins",
    note: "Anthropic, knowledge-work plugins",
    markersAtVerification: 213,
  },
  { repo: "anthropics/claude-for-legal", note: "Anthropic, legal skills", markersAtVerification: 151 },
  {
    repo: "anthropics/claude-plugins-official",
    note: "Anthropic, official plugin marketplace",
    markersAtVerification: 31,
  },

  // Same-org siblings of entries already on this list. These are the inconsistency that
  // exposed the staleness — one repo of an organisation curated, another not.
  { repo: "getsentry/sentry-for-ai", note: "Sentry, sibling of getsentry/skills", markersAtVerification: 35 },
  { repo: "expo/skills", note: "Expo, sibling of expo/expo", markersAtVerification: 26 },
  { repo: "vercel-labs/json-render", note: "Vercel Labs, sibling of vercel-labs/skills", markersAtVerification: 27 },

  // SaaS and developer-tool vendors.
  { repo: "forcedotcom/sf-skills", note: "Salesforce, first-party", markersAtVerification: 286 },
  { repo: "adobe/skills", note: "Adobe, first-party", markersAtVerification: 163 },
  { repo: "langchain-ai/langchain-skills", note: "LangChain, first-party", markersAtVerification: 23 },
  { repo: "clerk/skills", note: "Clerk, first-party", markersAtVerification: 23 },
  { repo: "shopify/shopify-ai-toolkit", note: "Shopify, first-party", markersAtVerification: 22 },
  { repo: "browserbase/skills", note: "Browserbase, first-party", markersAtVerification: 18 },
  { repo: "figma/mcp-server-guide", note: "Figma, first-party", markersAtVerification: 16 },
  { repo: "netlify/context-and-tools", note: "Netlify, first-party", markersAtVerification: 47 },
  { repo: "hubspot/agent-cli-skills", note: "HubSpot, first-party", markersAtVerification: 15 },
  { repo: "makenotion/notion-cookbook", note: "Notion, first-party", markersAtVerification: 194 },
  { repo: "apollographql/skills", note: "Apollo GraphQL, first-party", markersAtVerification: 15 },
  { repo: "planetscale/skills", note: "PlanetScale, first-party", markersAtVerification: 15 },
  { repo: "mapbox/mapbox-agent-skills", note: "Mapbox, first-party", markersAtVerification: 21 },
  { repo: "unity-technologies/skills", note: "Unity, first-party", markersAtVerification: 22 },
  { repo: "snyk/agent-scan", note: "Snyk, first-party", markersAtVerification: 21 },
  { repo: "medusajs/medusa-agent-skills", note: "Medusa, first-party", markersAtVerification: 18 },
  { repo: "copilotkit/copilotkit", note: "CopilotKit, product repo shipping its own skills", markersAtVerification: 30 },
  { repo: "coralogix/cx-cli", note: "Coralogix, first-party CLI", markersAtVerification: 21 },
  { repo: "firecrawl/firecrawl-workflows", note: "Firecrawl, first-party", markersAtVerification: 17 },
  { repo: "software-mansion/argent", note: "Software Mansion, first-party", markersAtVerification: 16 },
  { repo: "circlefin/skills", note: "Circle, first-party", markersAtVerification: 18 },
  { repo: "sumsub/agent-skills", note: "Sumsub, first-party", markersAtVerification: 26 },
  { repo: "celigo/ai", note: "Celigo, first-party", markersAtVerification: 24 },
  { repo: "prompt-security/clawsec", note: "Prompt Security, first-party", markersAtVerification: 17 },
  { repo: "remotion-dev/remotion", note: "Remotion, product repo shipping its own skills", markersAtVerification: 70 },
  { repo: "dlt-hub/dlt", note: "dltHub, product repo shipping its own skills", markersAtVerification: 19 },
  { repo: "MaterializeInc/materialize", note: "Materialize, product repo shipping its own skills", markersAtVerification: 20 },
  { repo: "nix-community/home-manager", note: "nix-community, first-party for home-manager", markersAtVerification: 19 },
  { repo: "hashintel/hash", note: "HASH, product repo shipping its own skills", markersAtVerification: 25 },
  { repo: "openclaw/openclaw", note: "OpenClaw, first-party", markersAtVerification: 144 },
  {
    repo: "liferay/liferay-portal",
    note: "Liferay, first-party; the root tree exceeds the ~100k entry cap, so it is read as scoped subtrees",
    markersAtVerification: 616,
    includePaths: ["workspaces/"],
  },
];

/**
 * **Curated lists** — human-filtered discovery (Doc 4 §2, class 2).
 *
 * These are not fetched for content. They are read as *link lists*: every GitHub repo URL
 * inside becomes a candidate that then goes through the ordinary enrich → decide → sync →
 * validate path. The curation signal is recorded as provenance, because "a human put this
 * on a list" is exactly the quality evidence the open crawl cannot generate.
 *
 * Lists are themselves repos, so they re-sync on the normal schedule and new entries flow
 * in without anyone touching this file.
 */
export type SeedList = {
  readonly repo: string;
  readonly note: string;
  /** Markdown files to read. Empty means "every .md at the root". */
  readonly files?: readonly string[];
};

export const SEED_LISTS: readonly SeedList[] = [
  {
    repo: "VoltAgent/awesome-agent-skills",
    note: "VoltAgent — the largest curated list, maintained by an engineering team",
  },
  {
    repo: "ComposioHQ/awesome-claude-skills",
    note: "Composio — curated Claude skills",
  },
  {
    repo: "karanb192/awesome-claude-skills",
    note: "karanb192 — carries verified badges per entry",
  },
  {
    repo: "travisvn/awesome-claude-skills",
    note: "travisvn — curated collection",
  },
  {
    repo: "hesreallyhim/awesome-claude-code",
    note: "the ecosystem directory — commands, workflows, CLAUDE.md files; a list, not a skill repo",
  },
];

/**
 * Repos that look like they belong and do not.
 *
 * Kept as an explicit list with reasons rather than silently omitted, so the next person to
 * read Doc 4 and wonder "why isn't Figma here?" gets an answer instead of re-checking.
 */
export const SEED_REJECTED: ReadonlyArray<{ repo: string; reason: string }> = [
  { repo: "figma/figma-skills", reason: "does not exist (404)" },
  { repo: "googlelabs/skills", reason: "does not exist (404)" },
  { repo: "netlify/netlify-mcp", reason: "exists, but contains no SKILL.md or AGENTS.md" },
  {
    repo: "forrestchang/andrej-karpathy-skills",
    reason:
      "does not exist (404) — the URL in specs/skill-registries is wrong; the real repo is multica-ai/andrej-karpathy-skills, which is on the list above",
  },
  {
    repo: "Ay-Skills",
    reason: "points at ayautomate.com rather than a repository; no GitHub source to fetch",
  },
];
