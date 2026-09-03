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
      "General programming work — application code, refactoring, debugging, testing, code quality, " +
      "language and framework specifics. The subject is the software's own source. Not the pipeline " +
      "or platform it runs on, which is devops-infrastructure: 'add a retry to this client' is " +
      "here, 'configure the deploy that ships it' is not. Not work whose purpose is finding or " +
      "preventing vulnerabilities, which is security. Not code whose subject is an agent, skill or " +
      "MCP server, which is meta-agent-tooling however ordinary the programming looks.",
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
      "CI/CD, containers, orchestration, cloud platforms, infrastructure as code, monitoring, " +
      "incident response, site reliability. The subject is how software is built, shipped, run and " +
      "observed rather than what it does. Not the application source itself, which is " +
      "software-engineering. Not agent, skill or MCP plumbing, which is meta-agent-tooling even " +
      "when it is expressed as a container or a workflow file. Not hardening or vulnerability work, " +
      "which is security.",
  },
  {
    id: "data-engineering",
    label: "Data engineering",
    description:
      "Pipelines, warehouses, ETL, databases, schema and query work, streaming, data quality. The " +
      "subject is moving, storing and shaping data so others can use it. Not analysing or modelling " +
      "it, which is data-science-ml: building the warehouse table is here, fitting a model on it is " +
      "not. Not the infrastructure the pipeline runs on, which is devops-infrastructure.",
  },
  {
    id: "data-science-ml",
    label: "Data science & ML",
    description:
      "Statistics, modelling, machine learning, LLM and prompt work, evaluation, notebooks, " +
      "experiment tracking. The subject is drawing conclusions from data or building models that " +
      "do. Not the plumbing that delivers the data, which is data-engineering. Not prompt or agent " +
      "scaffolding whose subject is an agent's own configuration, which is meta-agent-tooling.",
  },
  {
    id: "security",
    label: "Security",
    description:
      "Application and infrastructure security, threat modelling, vulnerability analysis, secrets " +
      "handling, penetration testing, incident forensics. Use this when finding, preventing or " +
      "responding to attack is the skill's purpose, not an incidental mention — a code review " +
      "looking for injection is here, a general code review that happens to note a hardcoded key is " +
      "software-engineering. Regulatory and policy obligations are legal-compliance.",
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
      "Product strategy, requirements, roadmaps, user stories, feature specification, " +
      "prioritisation. The subject is deciding what to build and why. Not tracking the delivery of " +
      "it — schedules, estimates, standups, status — which is project-management. Not the internal " +
      "running of the company, which is business-operations. Not user research and interface " +
      "decisions, which are design-ux.",
  },
  {
    id: "project-management",
    label: "Project & delivery management",
    description:
      "Planning, tracking, estimation, agile ceremonies, status reporting, resourcing, risk " +
      "management. The subject is getting agreed work delivered on time. Not choosing what the work " +
      "should be, which is product-management. Not an individual's own task and calendar habits, " +
      "which are productivity-personal. Not company-wide process and vendor administration, which " +
      "is business-operations.",
  },
  {
    id: "marketing",
    label: "Marketing",
    description:
      "Campaigns, SEO, content marketing, social media, advertising, brand, positioning, market and " +
      "competitor analysis. The subject is reaching and persuading an audience. Not writing craft " +
      "for its own sake, which is content-writing. Not selling to a named prospect — outreach, " +
      "proposals, pipeline — which is sales. Not storefront and catalogue mechanics, which is " +
      "e-commerce.",
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
      "Ticket handling, help-centre content, troubleshooting scripts, escalation, customer " +
      "communication. The subject is helping an existing customer with a problem. Not winning a new " +
      "one, which is sales. Not internal process design, which is business-operations. Not end-user " +
      "documentation written as a product artefact, which is content-writing.",
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
      "Contracts, policies, licensing, regulatory compliance, privacy, risk and governance. The " +
      "subject is an obligation that comes from law, licence or regulator. Not general internal " +
      "process, which is business-operations. Not technical attack and defence, which is security — " +
      "a GDPR data-handling review is here, a penetration test is not.",
  },
  {
    id: "human-resources",
    label: "HR & people",
    description:
      "Hiring, interviewing, onboarding, performance, compensation, employee policy and culture. " +
      "The subject is the employment relationship. Not general internal administration, which is " +
      "business-operations. Not curriculum and teaching material, which is education-training even " +
      "when the learners are staff.",
  },
  {
    id: "content-writing",
    label: "Writing & editing",
    description:
      "General writing craft — editing, style, tone, translation, summarisation, documentation " +
      "authoring. Use this when the writing itself is the subject. Not writing with a campaign or " +
      "audience-acquisition purpose, which is marketing. Not teaching material with learning " +
      "objectives or assessment, which is education-training. Not API and developer reference for " +
      "one's own code, which is software-engineering.",
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
      "The internal running of an organisation — vendor and procurement work, internal process " +
      "design, admin automation, cross-functional reporting, back-office workflow. Deliberately the " +
      "narrowest reading, because this is the entry most easily used as a default: prefer a " +
      "specific domain whenever one fits. Not product decisions (product-management), not delivery " +
      "tracking (project-management), not contracts, policy or regulatory obligation " +
      "(legal-compliance), not money and books (finance-accounting), not hiring and staff policy " +
      "(human-resources), and not an individual's own habits and workflow (productivity-personal).",
  },
  {
    id: "education-training",
    label: "Education & training",
    description:
      "Curriculum, lesson and course material, assessment, tutoring, learner feedback. The subject " +
      "is teaching someone else, with learning objectives or a way of checking understanding. Not " +
      "explaining a topic in passing — that is the explain *function*, and the domain is whatever " +
      "field is being explained. Not one's own habits, focus or study routine, which is " +
      "productivity-personal. Not research method and literature work, which is science-research.",
  },
  {
    id: "science-research",
    label: "Science & research",
    description:
      "Academic and scientific work — literature review, experimental method, citation and " +
      "reproduction, technical and bioinformatics research. The subject is producing or " +
      "synthesising new knowledge to a scholarly standard. Not teaching existing knowledge, which " +
      "is education-training. Not commercial market or competitor research, which is marketing.",
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
      "One individual's own workflow — notes, tasks, scheduling, email triage, focus and habits, " +
      "reading and knowledge management. The subject is a single person organising themselves. Not " +
      "team or company process, which is business-operations or project-management. Not teaching a " +
      "method to others, which is education-training.",
  },
  {
    id: "meta-agent-tooling",
    label: "Agent & skill tooling",
    description:
      "Skills whose subject is agents and skills themselves — skill authoring, agent and CLI " +
      "configuration, MCP servers, prompt and context libraries, subagent orchestration, developer " +
      "tooling for agent systems. The test is what the work is *about*, not what it is written in: " +
      "a Dockerfile for an MCP server is here rather than devops-infrastructure, and a TypeScript " +
      "library for defining tools is here rather than software-engineering. Skills that merely " +
      "happen to be written for an agent — which is all of them — do not belong here.",
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
 *
 * 1.2.0 — seventeen domain descriptions gained explicit **boundaries**, driven by measured
 *   confusion rather than by reading them and disliking them. Every description was a topic
 *   list with no exclusions, and the co-assignment counts showed exactly where that hurt:
 *   `devops-infrastructure` + `software-engineering` **419 times**, `business-operations` +
 *   `product-management` 103, + `project-management` 98, + `legal-compliance` 79,
 *   `security` + `software-engineering` 98, `devops-infrastructure` +
 *   `meta-agent-tooling` 127.
 *
 *   `business-operations` was the worst single entry at **avg confidence 66**, the lowest of
 *   all 26, and its description ("internal process, vendor and procurement work, admin
 *   automation, reporting, cross-functional operations") reads as a catch-all — so it was
 *   used as one. It now says it is the narrowest reading and names the six domains to prefer
 *   over it.
 *
 *   The nine domains with no measured pressure — `mobile` at avg 88, `healthcare` 86,
 *   `gaming` 83, `finance-accounting`, `design-ux`, `web-frontend`, `e-commerce`, `sales`,
 *   `media-production` — were left alone. Rewriting a description that is already deciding
 *   correctly buys nothing and costs a re-classification.
 *
 *   Cost of the bump: the 4,701 assignments at 1.1.0 become unlabelled to `selectSkills`, so
 *   they re-enter the queue and the catch-up grows by about $14. That is the price of the
 *   corpus agreeing with itself about what a category means, and it is why this constant
 *   exists rather than descriptions being edited freely.
 */
/*
 * 1.3.0 — the domain **multi-label rule**, not another description rewrite.
 *
 *   1.2.0 narrowed `meta-agent-tooling` in its description — "skills that merely happen to
 *   be written for an agent do not belong here" — and its share of domain labels went
 *   **up**, 19.9% → 23.2%. The description was not the cause. `SYSTEM` said, two rules
 *   later, *"Many skills are general-purpose developer tooling: for those, use the
 *   software-engineering or meta-agent-tooling domain rather than reaching for a specialised
 *   one"* — the prompt nominated it as the fallback, and an instruction beats a definition.
 *
 *   The rationales proved it rather than suggesting it. Every low-confidence
 *   `meta-agent-tooling` row *names a different primary domain in its own reasoning*:
 *   `spring-boot-engineer` at 35 — "serving general Java application domain";
 *   `import-infrastructure-as-code` at 35 — "software-engineering is primary domain";
 *   `codebase-documenter` at 35 — "the subject is explaining how application source code
 *   works". The model agreed with the definition and obeyed the instruction anyway. 104 of
 *   163 assignments sat alongside another domain; the high-confidence ones (92–95) are all
 *   genuinely agent tooling and are untouched by this.
 *
 *   The asymmetry across axes is the clincher. The function rule is restrictive — "Prefer
 *   ONE function. A second is for a skill that genuinely performs two distinct kinds of
 *   work" — and functions hold **2.7%**. The domain rule invited "one to three" and named a
 *   fallback, and domains hold **9.8%**. Same model, same skills, same call.
 *
 *   So the domain rule now mirrors the function rule and the fallback sentence is gone. The
 *   descriptions are unchanged: 1.2.0's boundary clauses did work where they could be
 *   measured — `business-operations` fell 8.3% → 3.6% of domain labels and
 *   `software-engineering` 21.1% → 18.9%.
 *
 *   Bumped even though no vocabulary *entry* moved, because `classifier_version` has to mean
 *   "what decided this label" for R7.2 to hold. A prompt change under a fixed version would
 *   leave 1.2.0 rows produced by two different classifiers. Cost: the 400 rows at 1.2.0
 *   re-enter the queue, about $1.20.
 */
export const TAXONOMY_VERSION = "1.3.0";

/**
 * Below this, an assignment is held for a curator instead of being served (R3.1's
 * low-confidence queue). Set at 60 rather than something tidier because the classifier is
 * asked for calibrated confidence and told what the number means: 60 is "more likely than
 * not, and I can name why". Tune against the queue depth once it is running.
 */
export const REVIEW_FLOOR = 60;
