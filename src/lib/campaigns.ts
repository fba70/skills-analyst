/**
 * Expertise capture campaigns (Doc 6 RK.8, plan step E7) — Team.
 *
 * *"Before a senior engineer rotates off or leaves, run Interview and Distill against their
 * domain in facilitated sessions; output is a reviewed skill portfolio."* Organisational-memory
 * insurance, which is a budget line enterprises already understand.
 *
 * ## The plan says "nothing new underneath it", and that is the specification
 *
 * Interview (C2b) elicits what somebody has not written down. Distill (C4) takes it from work
 * that already happened. Both produce typed candidate blocks through one accept path, and both
 * write into drafts. A campaign adds **no new way to capture anything**. What it adds is the
 * thing neither of them has: an answer to *are we finished*.
 *
 * ## A progress bar needs a denominator, and that is the whole design
 *
 * The tempting build is a bag of drafts with a count. That counts what happened and cannot say
 * whether it was enough — the same shape as a rate with no sample size, which this codebase
 * marks as thin everywhere it appears, and as *"we found 204 examples"* meaning nothing without
 * knowing how many were looked for.
 *
 * So a campaign is a **named list of topics** — *incident escalation, the Redis failover
 * runbook, the data-retention rules* — written down before the interviews start, by the person
 * who knows what is at risk. Progress is topics covered against topics named. Everything else
 * (sessions run, candidates accepted, skills published) is derived from the work itself and is
 * evidence rather than score.
 *
 * The list is also the artefact with value independent of the software: *what does this person
 * know that nobody else does* is the question the programme exists to force, and it has to be
 * answered by a human before any tool can help.
 */

export const CAMPAIGN_STATUSES = ["open", "closed"] as const;

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return typeof value === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * Where one topic has got to. **Derived, never stored.**
 *
 * A stored status is a second source of truth for something the draft already knows, and it goes
 * stale the moment somebody publishes without coming back to tick a box — which is exactly the
 * moment a progress bar most needs to be right. Same call as the lifecycle being computed at read
 * time and the transclusion state being derived from two version numbers.
 */
export const TOPIC_STATES = ["not-started", "drafting", "published"] as const;

export type TopicState = (typeof TOPIC_STATES)[number];

export const TOPIC_STATE_META: Record<TopicState, { label: string; blurb: string }> = {
  "not-started": {
    label: "Not started",
    blurb: "Named as something to capture. Nobody has opened a draft for it yet.",
  },
  drafting: {
    label: "In progress",
    blurb: "A draft exists. Interview and Distill write into it; a person still has to publish.",
  },
  published: {
    label: "Captured",
    blurb: "Published into the workspace, through the same pipeline every other skill goes through.",
  },
};

export function topicState(input: {
  draftId: string | null;
  publishedSkillId: string | null;
}): TopicState {
  if (input.publishedSkillId) return "published";
  if (input.draftId) return "drafting";
  return "not-started";
}

export type CampaignProgress = {
  topics: number;
  drafting: number;
  published: number;
  /** Sessions and distill runs across the campaign's drafts. Evidence, never a score. */
  interviews: number;
  distillRuns: number;
  /** Accepted candidate blocks — what the programme actually produced. */
  accepted: number;
};

/**
 * The share captured, or null when there is nothing to be a share of.
 *
 * Null rather than 0% for an empty campaign, and the distinction is the one this codebase keeps
 * paying for: *nothing has been captured* and *nothing was asked for* are the same zero and
 * opposite meanings, and a progress bar at 0% on a campaign with no topics reads as failure
 * where it should read as unstarted.
 */
export function capturedShare(progress: CampaignProgress): number | null {
  if (progress.topics === 0) return null;
  return Math.round((progress.published / progress.topics) * 100);
}

export const MAX_CAMPAIGN_NAME = 120;
export const MAX_TOPIC_TITLE = 160;

/** How many topics one campaign may name. A programme, not a backlog. */
export const MAX_TOPICS = 60;

export const CAMPAIGN_REFUSALS = [
  "not-found",
  "empty",
  "duplicate-topic",
  "too-many-topics",
  "closed",
] as const;

export type CampaignRefusal = (typeof CAMPAIGN_REFUSALS)[number];

export const CAMPAIGN_REFUSAL_MESSAGE: Record<CampaignRefusal, string> = {
  "not-found": "No such campaign.",
  empty: "Give it a name.",
  "duplicate-topic": "That topic is already on the list.",
  "too-many-topics": `A campaign names at most ${MAX_TOPICS} topics. More than that is a backlog, and a backlog has no end date.`,
  closed: "This campaign is closed. Reopen it to add to it.",
};
