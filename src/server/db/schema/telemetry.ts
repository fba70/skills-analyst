import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgPolicy,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";
import { skills, skillVersions } from "./corpus";
import { skillDrafts } from "./drafts";

/**
 * What authoring taught us (Doc 2 R6.2), bounded against poisoning (R6.5).
 *
 * One row per (draft, section role) at the moment a draft is published. This is the return
 * arrow: §2 says *the loop is the product*, and until now archetype regeneration had only
 * corpus prevalence to learn from — what people published elsewhere, never what happened
 * when someone actually used the skeleton.
 *
 * ## Structure only. Never content.
 *
 * Every column here is either a boolean or a value from a closed vocabulary we defined: the
 * function category, and a section role from the fourteen in `SECTION_ROLES`. **No skill
 * text, no names, no descriptions, no author input.** That is what makes this compatible
 * with RC.5 and OQ-C2, which forbid org-private corpora feeding public archetypes even in
 * aggregate: "the `troubleshooting` heading survived into a published skill" is a fact about
 * our own vocabulary, not about a customer's workflow.
 *
 * The minimum-distinct-organisations floor applied at aggregation time is the second half of
 * that guarantee. It exists for R6.5's anti-poisoning reasons *and* for privacy — below the
 * floor an aggregate could describe a single tenant, so it is not published at all. One
 * mechanism, two requirements, and it would be wrong to relax it for either.
 *
 * ## Deduplicated by construction
 *
 * `(draft_id, section_role)` is unique. R6.5 asks for deduplication per identity, and a
 * draft is the identity that matters: one authoring session contributes one opinion per
 * section, however many times it is regenerated or republished. Making that a database
 * constraint rather than application logic means a retry cannot double-count.
 */
export const builderSignals = pgTable(
  "builder_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** NOT NULL, like drafts. Used for rate-limiting and the distinct-org floor, never published. */
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    draftId: uuid("draft_id")
      .notNull()
      .references(() => skillDrafts.id, { onDelete: "cascade" }),
    /** The skill it became. Null if that skill is later deleted; the signal survives. */
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),

    /** Function category, from the closed taxonomy. */
    archetypeCategory: text("archetype_category").notNull(),
    /** Which skeleton was followed. Null when the category had no archetype. */
    archetypeVersion: integer("archetype_version"),
    /** A role from `SECTION_ROLES`. Never a raw heading. */
    sectionRole: text("section_role").notNull(),

    /** The scaffold proposed this section. */
    offered: boolean("offered").notNull(),
    /** The author wrote notes for it — engagement, distinct from survival. */
    authored: boolean("authored").notNull(),
    /** A heading for this role is present in the published document. */
    survived: boolean("survived").notNull(),
    /**
     * The published skill passed validation on its first pass (G3).
     *
     * Denormalised onto every row of the draft rather than kept once: the question these
     * rows answer is "which archetype elements correlate with first-pass success", and that
     * correlation is computed per section, so the outcome has to sit beside the section.
     */
    firstPassValid: boolean("first_pass_valid").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // R6.5's dedup, as a constraint rather than a convention.
    uniqueIndex("builder_signals_draft_role_uq").on(t.draftId, t.sectionRole),
    index("builder_signals_category_idx").on(t.archetypeCategory, t.sectionRole),
    index("builder_signals_org_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * What happened to a skill after publication (Doc 2 R6.3).
 *
 * ## The half of the loop that was missing, and its honest limit
 *
 * `builder_signals` above records what happened *while* a skill was written. This records
 * what happened *to it afterwards* — downloads, whether it survived re-validation, whether
 * anyone withdrew or deprecated it. Without it, every claim the platform makes about "what
 * good looks like" is a statement about what the corpus **contains** rather than about what
 * **worked**.
 *
 * The limit is worth stating on the table itself, because it is easy to over-read: only
 * skills authored here carry archetype lineage, so `archetype_category` and
 * `archetype_version` are NULL for the entire ingested corpus. R6.3's *attribution* half
 * therefore has almost no data and will not until builder volume grows. The *collection*
 * half is useful immediately — it is what makes RK.1's `battle-tested` earnable and RK.7's
 * impact analytics possible — and the aggregates report their own sample size so nobody
 * mistakes three signals for evidence.
 *
 * ## One row per identity per day, which is the dedup
 *
 * The unique index is `(skill_version_id, kind, day, caller_digest)`, so counting rows *is*
 * the deduplicated count and there is no counter to drift. R6.5 asks for dedup per identity;
 * this is that, done in the index rather than in application logic that a second call site
 * could forget.
 *
 * ## `caller_digest` identifies nobody, and is designed not to
 *
 * A daily-rotating HMAC of the caller key, truncated. It exists so one reader downloading
 * one skill twice in a day counts once, and it is not linkable across days nor back to an
 * address. **No IP, no user agent, no session, no token id is stored here.** System-generated
 * signals — a re-validation, a withdrawal — use the literal `system`, since there is no
 * caller and the same event twice in a day is the same event.
 *
 * With no salt configured the digest degrades to a per-day constant, so every caller
 * collides and a skill records at most one download a day. That is the correct direction to
 * fail: it **undercounts**. A signal that can inflate an archetype must never fail towards
 * counting more.
 *
 * ## Read-open, and safe for the same reason `builder_signals` is
 *
 * Aggregating across organisations is the point, so the read policy is open — and it is safe
 * **because of the column list**: a skill id, a kind from a closed vocabulary, a date, and an
 * unlinkable digest. No skill text, no author, no reader. Add a column carrying tenant
 * content and this policy becomes wrong, exactly as the migration for `builder_signals` says.
 */
export const outcomeSignals = pgTable(
  "outcome_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Org-scoped on write so a private skill's outcomes stay inside its tenant (RC.5). */
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),

    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    /**
     * The version the outcome happened to.
     *
     * Pinned, not rolled up to the skill, because a re-validation failure belongs to the
     * version that failed — attributing it to the skill would blame content that may have
     * been replaced since.
     */
    skillVersionId: uuid("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),

    kind: text("kind").notNull(),

    /**
     * Archetype lineage, when there is any.
     *
     * NULL for every ingested skill — they were not scaffolded from an archetype, so there
     * is nothing to attribute to. Set only for skills published through the builder (R6.1),
     * which is what closes R6.3's attribution loop as that volume grows.
     */
    archetypeCategory: text("archetype_category"),
    archetypeVersion: integer("archetype_version"),

    /** Calendar day, UTC. The dedup window, and the axis a trend is read on. */
    day: date("day").notNull(),
    /** See the note above: a daily-rotating HMAC, or the literal `system`. */
    callerDigest: text("caller_digest").notNull(),

    /**
     * A number, when the kind carries one — an eval delta in points, for instance.
     *
     * Nullable and deliberately unitless at the schema level: the kind says what it means.
     * Nothing writes it yet.
     */
    value: real("value"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Counting rows is the deduplicated count. See the note above. */
    uniqueIndex("outcome_signals_uq").on(t.skillVersionId, t.kind, t.day, t.callerDigest),
    index("outcome_signals_skill_idx").on(t.skillId, t.kind),
    /** The attribution query: everything for one archetype version. */
    index("outcome_signals_archetype_idx").on(t.archetypeCategory, t.archetypeVersion),
    index("outcome_signals_day_idx").on(t.day),

    /**
     * The schema's **fourth split policy**, and the same argument as `builder_signals`.
     *
     * Writes are org-scoped so a tenant's outcomes cannot be forged from another tenant.
     * Reads are open because cross-organisation aggregation is the entire point of R6.3 — a
     * read policy keyed on `app.org_id` would let an archetype learn from one tenant at a
     * time, which is useless and is the shape RC.5 forbids. Safe because of the column list.
     */
    pgPolicy("read_all", {
      for: "select",
      to: "app_runtime",
      using: sql`true`,
    }),
    pgPolicy("org_write", {
      for: "insert",
      to: "app_runtime",
      withCheck: sql`org_id is null or org_id = current_setting('app.org_id', true)`,
    }),
  ],
);
