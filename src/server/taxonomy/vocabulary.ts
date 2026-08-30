/**
 * The curated taxonomy (Doc 2 R3.1).
 *
 * No `import "server-only"`: this is a leaf module of plain constants with no imports, and
 * the curator UI needs the labels. Nothing here reaches the database or the network.
 *
 * ## Why a curated list at all
 *
 * Because the corpus does not carry one. Across 2,531 ingested skills, **zero** declare a
 * category or a tag — the only frontmatter keys that appear on more than half of them are
 * `name` and `description`. The Agent Skills standard has no category field, and every
 * registry invents its own list. So there is nothing to import and nothing to agree with:
 * the taxonomy is ours, and it is derived, not read.
 *
 * Closed and curated rather than free-form, following the one analogue that works at
 * scale — Hugging Face's `pipeline_tag`, a fixed task list everything else hangs off. The
 * negative example is npm keywords: free-form, unbounded, and useless for aggregation,
 * which is exactly what archetype mining needs the taxonomy to be good at.
 *
 * ## Destined for the settings table
 *
 * These lists are policy, and CLAUDE.md's standing note applies: policy becomes data.
 * Adding a category should not be a redeploy once the corpus is live, because "is this
 * category real or is it two categories" is a question you answer by looking at the
 * corpus, repeatedly. Keeping both vocabularies in one module makes that a migration of
 * one file rather than an archaeology exercise.
 */

export type CategoryAxis = "domain" | "function";

export type Category = {
  /** Stable slug. Stored in `skill_categories.value`; never renamed once assigned. */
  readonly id: string;
  readonly label: string;
  /** Shown to the classifier and to the curator. Carries the whole decision boundary. */
  readonly description: string;
};

/**
 * **Function — what the skill does.** This is the axis archetypes are mined on.
 *
 * Structure follows function. A skill that reviews a marketing brief and one that reviews
 * a pull request share a shape (rubric, severity levels, output format); a skill that
 * writes an HR policy and one that writes a landing page share a different shape (template,
 * placeholders, examples). Mining per function gives a skeleton that transfers; mining per
 * domain would average incompatible shapes together.
 *
 * Deliberately small. Twelve buckets that differ *structurally* beat forty that differ by
 * subject matter — a distinction the domain axis already carries.
 */
export const FUNCTIONS: readonly Category[] = [
  {
    id: "review",
    label: "Review & critique",
    description:
      "Judges an existing artifact against criteria and reports findings — code review, security audit, copy critique, design review, compliance check. Output is a verdict or a findings list, not a new artifact.",
  },
  {
    id: "generate-document",
    label: "Generate a document",
    description:
      "Produces prose or a structured document from a brief or template — reports, policies, specs, posts, emails, proposals, summaries meant to be delivered as a document.",
  },
  {
    id: "generate-code",
    label: "Generate code",
    description:
      "Writes or scaffolds source code, configuration, or tests — boilerplate, components, migrations, whole project skeletons.",
  },
  {
    id: "edit-refactor",
    label: "Edit & refactor",
    description:
      "Changes an existing artifact while keeping its purpose — refactoring or simplifying code, editing prose, restyling or reformatting a document, applying a theme. The defining trait is that something already exists and comes back changed, not replaced.",
  },
  {
    id: "transform-data",
    label: "Extract & transform data",
    description:
      "Reads structured or semi-structured DATA in one shape and emits another — parsing, extraction from documents, format conversion, cleaning, reshaping, migration between schemas. Not for restyling or rewriting a human-facing artifact; that is edit-refactor.",
  },
  {
    id: "analyze-data",
    label: "Analyze data",
    description:
      "Computes insight from a dataset — statistics, aggregation, charting, anomaly detection, metric reporting. The output is a finding about the data, not the reshaped data itself.",
  },
  {
    id: "automate-browser",
    label: "Automate a browser or GUI",
    description:
      "Drives a web page or desktop interface — navigation, form filling, scraping through a rendered page, screenshotting, end-to-end UI testing.",
  },
  {
    id: "integrate-api",
    label: "Integrate an external service",
    description:
      "Wraps a specific third-party API or CLI so an agent can call it — auth, endpoints, request shapes, error handling for one named service.",
  },
  {
    id: "orchestrate",
    label: "Orchestrate agents & workflows",
    description:
      "Coordinates other skills, subagents, or multi-step pipelines — delegation, fan-out, sequencing, state handoff between steps.",
  },
  {
    id: "research",
    label: "Research & synthesize",
    description:
      "Gathers information from multiple external sources and synthesizes an answer — literature review, competitive scan, fact-finding, source comparison.",
  },
  {
    id: "configure-environment",
    label: "Configure & deploy",
    description:
      "Sets up or changes an environment — installing, provisioning, deploying, CI/CD wiring, infrastructure and platform configuration.",
  },
  {
    id: "explain",
    label: "Explain & teach",
    description:
      "Answers questions about a subject, a codebase, or a product, and teaches the reader — onboarding guides, reference lookups, concept explanations, troubleshooting help.",
  },
  {
    id: "plan",
    label: "Plan & decompose",
    description:
      "Turns a goal into structured work — roadmaps, task breakdowns, architecture decisions, estimates, project plans, requirement specs.",
  },
] as const;

/**
 * **Domain — what field the skill serves.** Drives browse, filter and category pages.
 *
 * Wider than the function axis on purpose: a user browsing wants their own field named,
 * and a domain that turns out to be two domains is cheap to split because nothing
 * structural hangs off it.
 */
export const DOMAINS: readonly Category[] = [
  {
    id: "software-engineering",
    label: "Software engineering",
    description:
      "General programming work — application code, refactoring, debugging, testing, code quality, language and framework specifics.",
  },
  {
    id: "web-frontend",
    label: "Web & frontend",
    description:
      "Browser-facing work — HTML/CSS, UI frameworks, styling systems, accessibility, web performance.",
  },
  {
    id: "mobile",
    label: "Mobile",
    description: "iOS, Android and cross-platform mobile app development and release.",
  },
  {
    id: "devops-infrastructure",
    label: "DevOps & infrastructure",
    description:
      "CI/CD, containers, orchestration, cloud platforms, infrastructure as code, monitoring, incident response, site reliability.",
  },
  {
    id: "data-engineering",
    label: "Data engineering",
    description:
      "Pipelines, warehouses, ETL, databases, schema and query work, streaming, data quality.",
  },
  {
    id: "data-science-ml",
    label: "Data science & ML",
    description:
      "Statistics, modelling, machine learning, LLM and prompt work, evaluation, notebooks, experiment tracking.",
  },
  {
    id: "security",
    label: "Security",
    description:
      "Application and infrastructure security, threat modelling, vulnerability analysis, secrets handling, penetration testing, incident forensics.",
  },
  {
    id: "design-ux",
    label: "Design & UX",
    description:
      "Visual and interaction design, design systems, prototyping, user research, usability.",
  },
  {
    id: "product-management",
    label: "Product management",
    description:
      "Product strategy, requirements, roadmaps, user stories, feature specification, prioritisation.",
  },
  {
    id: "project-management",
    label: "Project & delivery management",
    description:
      "Planning, tracking, estimation, agile ceremonies, status reporting, resourcing, risk management.",
  },
  {
    id: "marketing",
    label: "Marketing",
    description:
      "Campaigns, SEO, content marketing, social media, advertising, brand, positioning, market and competitor analysis.",
  },
  {
    id: "sales",
    label: "Sales",
    description:
      "Prospecting, outreach, CRM work, proposals, pricing, negotiation, pipeline and revenue operations.",
  },
  {
    id: "customer-support",
    label: "Customer support",
    description:
      "Ticket handling, help-centre content, troubleshooting scripts, escalation, customer communication.",
  },
  {
    id: "finance-accounting",
    label: "Finance & accounting",
    description:
      "Budgeting, forecasting, bookkeeping, invoicing, financial modelling and reporting, tax, audit.",
  },
  {
    id: "legal-compliance",
    label: "Legal & compliance",
    description:
      "Contracts, policies, licensing, regulatory compliance, privacy, risk and governance.",
  },
  {
    id: "human-resources",
    label: "HR & people",
    description:
      "Hiring, interviewing, onboarding, performance, compensation, employee policy and culture.",
  },
  {
    id: "content-writing",
    label: "Writing & editing",
    description:
      "General writing craft — editing, style, tone, translation, summarisation, documentation authoring.",
  },
  {
    id: "media-production",
    label: "Media production",
    description:
      "Image, audio and video creation and editing, generative media, presentations, publishing.",
  },
  {
    id: "e-commerce",
    label: "E-commerce & retail",
    description:
      "Storefronts, catalogues, pricing, inventory, orders, payments, merchandising, fulfilment.",
  },
  {
    id: "business-operations",
    label: "Business operations",
    description:
      "Internal process, vendor and procurement work, admin automation, reporting, cross-functional operations.",
  },
  {
    id: "education-training",
    label: "Education & training",
    description:
      "Curriculum, lesson and course material, assessment, tutoring, learner feedback.",
  },
  {
    id: "science-research",
    label: "Science & research",
    description:
      "Academic and scientific work — literature, experiments, methods, citation, technical and bioinformatics research.",
  },
  {
    id: "healthcare",
    label: "Healthcare",
    description:
      "Clinical, medical and health work — documentation, coding, guidelines, patient communication.",
  },
  {
    id: "gaming",
    label: "Games",
    description: "Game design, engines, gameplay systems, level and narrative work, game assets.",
  },
  {
    id: "productivity-personal",
    label: "Personal productivity",
    description:
      "Individual workflow — notes, tasks, scheduling, email triage, reading and knowledge management.",
  },
  {
    id: "meta-agent-tooling",
    label: "Agent & skill tooling",
    description:
      "Skills about building agents and skills themselves — skill authoring, agent configuration, MCP servers, prompt libraries, developer tooling for agent systems.",
  },
] as const;

export const FUNCTION_IDS: readonly string[] = FUNCTIONS.map((c) => c.id);
export const DOMAIN_IDS: readonly string[] = DOMAINS.map((c) => c.id);

export function categoriesFor(axis: CategoryAxis): readonly Category[] {
  return axis === "function" ? FUNCTIONS : DOMAINS;
}

export function labelFor(axis: CategoryAxis, id: string): string {
  return categoriesFor(axis).find((c) => c.id === id)?.label ?? id;
}

export function isValidCategory(axis: CategoryAxis, id: string): boolean {
  return categoriesFor(axis).some((c) => c.id === id);
}

/**
 * Bump when a vocabulary entry is added, removed, or its description changes enough to
 * move the decision boundary. This is the re-classification selector, and it is stored on
 * every assignment — the same contract analyzers have with `verdicts.analyzer_version`.
 */
export const TAXONOMY_VERSION = "1.1.0";

/**
 * Below this, an assignment is held for a curator instead of being served (R3.1's
 * low-confidence queue). Set at 60 rather than something tidier because the classifier is
 * asked for calibrated confidence and told what the number means: 60 is "more likely than
 * not, and I can name why". Tune against the queue depth once it is running.
 */
export const REVIEW_FLOOR = 60;
