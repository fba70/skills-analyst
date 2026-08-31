import type { Metadata } from "next";
import Link from "next/link";

import { LicenseBadge, licensePostureDetail, POSTURE_KEYS } from "@/components/registry/license-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CAPABILITY_META } from "@/lib/capabilities";
import { FAQ_SECTIONS, type FaqAnchor } from "@/lib/faq";
import {
  QUALITY_BANDS,
  SEVERITY_WEIGHTS,
  SUBSTANCE_FLOOR,
  SUBSTANTIAL_BYTES,
} from "@/lib/quality";
import { SECTION_ROLE_META } from "@/lib/section-roles";
import { EVIDENCE_GATE } from "@/server/analytics/archetype-read";
import { ANALYZER_VERSIONS } from "@/server/validation/run";
import { DOMAINS, FUNCTIONS, REVIEW_FLOOR, TAXONOMY_VERSION } from "@/server/taxonomy/vocabulary";

export const metadata: Metadata = {
  title: "FAQ",
  description:
    "What the scores, badges, licences, categories and archetypes on Skills Foundry actually mean.",
};

/**
 * The reference page (supports R8.1's trust surfaces).
 *
 * Every number on this platform is a judgement someone made, and until now none of them
 * were explained anywhere a visitor could reach. "100/100" is meaningless without the
 * formula; "quarantined" reads as an accusation without the rule; "Not mirrored" looks like
 * a bug rather than a licence. A registry whose whole claim is trustworthiness has to be
 * able to answer "what does that mean" without a conversation.
 *
 * ## Generated from the code, not written alongside it
 *
 * Almost nothing here is prose about values — the values are imported. Categories come from
 * `FUNCTIONS`/`DOMAINS`, capabilities from `CAPABILITY_META`, licence postures from the same
 * module the badges render from, severity weights and the substance curve from
 * `lib/quality.ts`, the analyzer list from `ANALYZER_VERSIONS`, the archetype gate from
 * `EVIDENCE_GATE`, the review floor from the taxonomy vocabulary.
 *
 * That is the only way a page like this survives. Documentation that restates constants is
 * wrong within a month, and a reader who checks one number, finds it stale, and stops
 * trusting the rest has lost more than the page ever gave them. If a threshold moves, this
 * page moves with it or fails to compile.
 */
export default function FaqPage() {
  return (
    <div className="grid min-w-0 gap-8">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          What everything here means
        </h1>
        {/*
          The measure is set on the intro paragraph, not on the page.

          A `max-w-*` on the root made this the one route in the app that did not fill its
          shell, so it sat in a column against the left edge while every sibling — registry,
          archetypes, dashboard — used the full width. The page frame is the layout's job;
          keeping a heading readable is this paragraph's, exactly as on `/archetypes`.
        */}
        <p className="text-muted-foreground max-w-3xl">
          Every badge, score and category on this platform is a judgement with a rule behind
          it. This page is those rules. The numbers below are read from the running system,
          so they cannot drift from what the registry actually does.
        </p>
      </header>

      <nav aria-label="Contents" className="flex flex-wrap gap-2">
        {FAQ_SECTIONS.map((section) => (
          <Badge key={section.id} variant="outline" className="font-normal">
            <a href={`#${section.id}`} className="hover:text-foreground">
              {section.title}
            </a>
          </Badge>
        ))}
      </nav>

      <Section id="quality" title="Quality score">
        <Q q="What does 100/100 mean?">
          <p>
            It is a composite score out of 100, computed from two things: what the analyzers
            found, and how much document there is to judge. 100 means{" "}
            <strong>no analyzer raised a single finding</strong> and the body is at least{" "}
            {SUBSTANTIAL_BYTES.toLocaleString()} bytes — roughly 330 words.
          </p>
          <p className="text-muted-foreground">
            It is a quality signal, not a safety verdict. A skill only appears in the
            registry at all if it passed validation, so a low score means &ldquo;thin or
            untidy&rdquo;, never &ldquo;dangerous&rdquo;.
          </p>
        </Q>

        <Q q="How is it calculated?">
          <p className="font-mono text-sm">
            score = (100 − findings) × substance
          </p>
          <p>Each finding subtracts by severity:</p>
          <ul className="grid gap-1">
            {Object.entries(SEVERITY_WEIGHTS).map(([severity, weight]) => (
              <li key={severity} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="capitalize">{severity}</span>
                <span className="text-muted-foreground tabular-nums">−{weight}</span>
              </li>
            ))}
          </ul>
          <p>
            <strong>Substance</strong> scales the result between {SUBSTANCE_FLOOR} and 1
            depending on body length, reaching full credit at{" "}
            {SUBSTANTIAL_BYTES.toLocaleString()} bytes.
          </p>
          <p className="text-muted-foreground">
            That second term exists because the score used to be penalties alone — which
            measures the <em>absence of problems</em> and calls it quality. A four-word skill
            has nothing to penalise, so the shortest documents in the corpus ranked highest,
            and 87% of everything sat at 99 or 100. A near-constant is not a ranking signal.
            The {SUBSTANCE_FLOOR} floor means a clean but thin skill still scores
            respectably: thin is not broken.
          </p>
        </Q>

        <Q q="Why is the badge a different colour?">
          <p>
            {QUALITY_BANDS.strong} and above is strong, {QUALITY_BANDS.fair}–
            {QUALITY_BANDS.strong - 1} is fair, below {QUALITY_BANDS.fair} is weak.{" "}
            <em>Unscored</em> means validation has not finished, not that it failed.
          </p>
        </Q>
      </Section>

      <Section id="validation" title="Validation">
        <Q q="What is checked?">
          <p>
            Every skill is judged by these analyzers before it is served. Each verdict keeps
            its evidence and the analyzer version that produced it, so a judgement can always
            be traced and re-run.
          </p>
          <ul className="grid gap-1.5">
            {Object.entries(ANALYZER_VERSIONS).map(([name, version]) => (
              <li key={name} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">{name.replace(/-/g, " ")}</span>
                <span className="text-muted-foreground font-mono text-xs">v{version}</span>
                <span className="text-muted-foreground">{ANALYZER_BLURBS[name] ?? ""}</span>
              </li>
            ))}
          </ul>
        </Q>

        <Q q="What is the difference between a warning and a block?">
          <p>
            Blocking is reserved for <strong>safety</strong>. A missing frontmatter field or
            an untidy heading is a defect and costs quality points, but it does not hide a
            skill — hiding hundreds of real skills over a convention would be a quality
            decision wearing a trust decision&rsquo;s clothes. A leaked credential or an
            injection attempt blocks.
          </p>
        </Q>

        <Q q="What does each status mean?">
          <dl className="grid gap-2">
            {STATUSES.map((status) => (
              <div key={status.term} className="grid gap-0.5">
                <dt className="text-sm font-medium">{status.term}</dt>
                <dd className="text-muted-foreground text-sm">{status.detail}</dd>
              </div>
            ))}
          </dl>
        </Q>
      </Section>

      <Section id="licences" title="Licences and downloads">
        <Q q="Why can I download some skills and not others?">
          <p>
            Because the upstream licence decides. We resolve a licence for every skill and
            record how we found it; the posture below is what that licence permits{" "}
            <em>us</em> to do with the content.
          </p>
          <ul className="grid gap-2">
            {POSTURE_KEYS.map((posture) => (
              <li key={posture} className="grid gap-1">
                <LicenseBadge redistribution={posture} spdx={null} />
                <span className="text-muted-foreground text-sm">
                  {licensePostureDetail(posture)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            A skill we may not copy is still fully indexed, judged and scored — you get the
            verdicts and a link to the origin, just not the bytes.
          </p>
        </Q>

        <Q q="Is a download the same bytes that were validated?">
          <p>
            Yes, and it is checkable. Storage is content-addressed, so the key <em>is</em>{" "}
            the hash the verdict covers. Every archive carries the content hash and the
            validation-report hash, both recomputable from the archive alone, and two
            downloads of the same skill are byte-identical.
          </p>
        </Q>
      </Section>

      <Section id="capabilities" title="What a skill can reach">
        <Q q="What are capabilities?">
          <p>
            What the bundled code can touch, detected by reading it. This is description,
            never accusation: a deployment skill that runs shell commands is doing its job.
          </p>
          <ul className="grid gap-1.5">
            {Object.entries(CAPABILITY_META).map(([key, meta]) => (
              <li key={key} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">{meta.label}</span>
                <span className="text-muted-foreground">{meta.blurb}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            The thing worth flagging is a capability the documentation never mentions —
            marked <em>undocumented</em> on a skill&rsquo;s page.
          </p>
        </Q>
      </Section>

      <Section id="categories" title="Categories">
        <Q q="Where do categories come from?">
          <p>
            They are derived, not read. Across the corpus, effectively no skill declares a
            category — the Agent Skills standard has no such field — so we classify every
            skill against a curated vocabulary (version {TAXONOMY_VERSION}).
          </p>
          <p>
            There are two independent axes, and the split is deliberate:{" "}
            <strong>structure follows function</strong>. A skill that reviews a contract and
            one that reviews a pull request share a shape; one that writes an HR policy and
            one that writes a landing page share a different shape. Archetypes are mined on
            the function axis for exactly that reason.
          </p>
        </Q>

        <Q q={`Function — what the skill does (${FUNCTIONS.length})`}>
          <dl className="grid gap-2">
            {FUNCTIONS.map((category) => (
              <div key={category.id} className="grid gap-0.5">
                <dt className="text-sm font-medium">{category.label}</dt>
                <dd className="text-muted-foreground text-sm">{category.description}</dd>
              </div>
            ))}
          </dl>
        </Q>

        <Q q={`Domain — what field it serves (${DOMAINS.length})`}>
          <dl className="grid gap-2">
            {DOMAINS.map((category) => (
              <div key={category.id} className="grid gap-0.5">
                <dt className="text-sm font-medium">{category.label}</dt>
                <dd className="text-muted-foreground text-sm">{category.description}</dd>
              </div>
            ))}
          </dl>
        </Q>

        <Q q="Why does a skill sometimes have no category?">
          <p>
            Each assignment carries a confidence. Below {REVIEW_FLOOR} it is held back rather
            than shown — an uncertain guess should not quietly decide what you see. A skill
            with no usable description is not classified at all, because there is nothing for
            a classifier to read.
          </p>
        </Q>
      </Section>

      <Section id="archetypes" title="Archetypes">
        <Q q="What is an archetype?">
          <p>
            What a good skill in a category actually looks like, derived from the corpus
            rather than asserted. See{" "}
            <Link href="/archetypes" className="underline underline-offset-4">
              the archetypes
            </Link>
            .
          </p>
        </Q>

        <Q q="What is “lift”?">
          <p>
            The gap between two groups. Every element is measured in skills from a curated
            allow-list of publishers <em>and</em> in everything else; lift is the difference.
          </p>
          <p className="text-muted-foreground">
            This is the whole method. A section present in 90% of good skills and 90% of weak
            ones is not advice — it is a description of markdown. Only elements that{" "}
            <em>separate</em> the two groups earn a place, which is why an archetype is short.
          </p>
        </Q>

        <Q q="How much evidence is behind one?">
          <p>
            An archetype is only published once its category has at least{" "}
            {EVIDENCE_GATE.structures} <strong>distinct document structures</strong> across{" "}
            {EVIDENCE_GATE.sources} sources. Structures rather than skills: one generator&rsquo;s
            three hundred near-identical copies count once, or a single prolific publisher
            could manufacture a convention.
          </p>
        </Q>

        <Q q="What are section roles?">
          <p>
            The moves a skill document makes, normalised. &ldquo;When to use this&rdquo;,
            &ldquo;When to use this skill&rdquo; and &ldquo;Triggers&rdquo; are three strings
            and one idea, so archetypes count the idea.
          </p>
          <dl className="grid gap-2">
            {Object.entries(SECTION_ROLE_META).map(([role, meta]) => (
              <div key={role} className="grid gap-0.5">
                <dt className="text-sm font-medium">{meta.label}</dt>
                <dd className="text-muted-foreground text-sm">{meta.blurb}</dd>
              </div>
            ))}
          </dl>
        </Q>
      </Section>

      <Section id="duplicates" title="Duplicates and provenance">
        <Q q="Why do some skills say “+3 near-duplicates”?">
          <p>
            The same skill is often republished across repositories. We compare the text of
            every skill and fold near-identical ones under one canonical entry, so a search
            returns distinct skills rather than sixty copies of the same file. The copies keep
            their own provenance and stay reachable from the entry they were folded into.
          </p>
          <p className="text-muted-foreground">
            Descriptions have to match too, not just bodies. Template-generated skills share
            almost all of their text and are genuinely different skills — clustering on the
            body alone once hid 66 of them behind a single scaffold.
          </p>
        </Q>

        <Q q="Where does a skill come from?">
          <p>
            Every skill records its source repository, path, commit and licence evidence, and
            content is always re-fetched from origin. Attribution-required licences render
            attribution wherever the content appears.
          </p>
        </Q>

        <Q q="How current is this?">
          <p>
            Sources are re-synced on a schedule and a skill deleted upstream is withdrawn
            here, with its metadata kept so links keep resolving. The{" "}
            <Link href="/" className="underline underline-offset-4">
              home page
            </Link>{" "}
            shows how long ago the last sync ran.
          </p>
        </Q>
      </Section>

      {/*
        Agent access.

        The rest of this page explains what a badge means to a person reading it. This
        section explains the same corpus to the thing that will actually consume most of it,
        and it belongs on the public FAQ rather than behind a login: someone deciding whether
        to point an agent here needs to know the terms *before* creating an account.
      */}
      <Section id="mcp" title="Agent access (MCP)">
        <Q q="Can an agent query this registry directly?">
          <p>
            Yes. There is an MCP server at <code className="text-sm">/api/mcp</code>, so an
            agent can search the corpus, read a skill&rsquo;s verdicts and provenance, fetch a
            category archetype and resolve a download — without a person in the loop.
          </p>
          <p className="text-muted-foreground">
            Six tools: <code className="text-xs">search_skills</code>,{" "}
            <code className="text-xs">get_skill</code>,{" "}
            <code className="text-xs">download_skill</code>,{" "}
            <code className="text-xs">list_archetypes</code>,{" "}
            <code className="text-xs">get_archetype</code> and{" "}
            <code className="text-xs">corpus_stats</code>. Search takes structured filters —
            function category, domain, capability, licence posture, minimum quality — rather
            than one free-text box, because an agent fills a schema better than it phrases a
            query.
          </p>
        </Q>

        <Q q="What does it cost, and why do I need an account?">
          <p>
            It is <strong>free</strong>. The account is not a paywall — it is a name to count
            requests against.
          </p>
          <p className="text-muted-foreground">
            An anonymous caller offers only an IP address, which is shared by everyone behind
            one office router and changed by anyone who wants to. A rate limit built on that
            bounds accidents and nothing else. A free account issues a revocable token, so the
            limit applies to <em>you</em> rather than to a network. Nothing behind the token is
            hidden from the web: every verdict, licence and provenance record it returns is on
            a public page that needs no account at all.
          </p>
          <p className="text-muted-foreground">
            Create one in <strong>Account → MCP access</strong>. The token is shown once,
            because only a hash of it is stored; revoking takes effect on the next request.
          </p>
        </Q>

        <Q q="What is paid, then?">
          <p>
            The split is by <strong>scope</strong>, never by quality of answer. Looking up one
            skill is free forever; asking for all of them, continuously, is the commercial
            part.
          </p>
          <ul className="grid gap-1.5">
            <li className="text-sm">
              <strong>Free</strong> — search, skill detail with verdicts and provenance,
              archetype snapshots, downloads where the licence permits.
            </li>
            <li className="text-muted-foreground text-sm">
              <strong>Paid</strong> — bulk and by-content-hash lookup, the live archetype feed
              rather than the published snapshot, workspace-private corpora, and tools that
              call a model. Not built yet.
            </li>
          </ul>
          <p className="text-muted-foreground">
            A tier that returned a coarser verdict, a delayed one, or fewer findings is the one
            shape of paywall this platform has committed against. Security information about a
            public skill is never the thing being sold.
          </p>
        </Q>

        <Q q="Is it safe to let an agent read skills from here?">
          <p>
            Safer than fetching them yourself, and the tools are built so you can check rather
            than trust.
          </p>
          <p className="text-muted-foreground">
            A skill is a document written by a stranger for the express purpose of steering an
            agent, so every tool returns corpus text inside a labelled{" "}
            <code className="text-xs">&lt;untrusted-corpus-content&gt;</code> fence carrying its
            source, its validation status and its quality score — data to be evaluated, never
            instructions to follow. The fence is closed with a one-time random marker, so a
            skill cannot write its own closing tag and escape it.
          </p>
          <p className="text-muted-foreground">
            Alongside it you get the verdicts and the capability surface — whether the bundled
            code touches the network, the filesystem, a shell or credentials — which is what an
            install decision should actually be made on.
          </p>
        </Q>

        <Q q="What happens when I hit the rate limit?">
          <p>
            You get HTTP <code className="text-sm">429</code> with a{" "}
            <code className="text-sm">Retry-After</code> header, and a message naming which
            window you hit and the exact time it lifts.
          </p>
          <p className="text-muted-foreground">
            It is stated that way on purpose. An agent that cannot tell a throttle from a
            permission failure will either retry a hard failure for ever or abandon a request
            that would have worked a minute later, and both look like our fault from the
            outside.
          </p>
        </Q>
      </Section>
    </div>
  );
}

/**
 * One line per analyzer, keyed by the name it registers under.
 *
 * The names and versions come from `ANALYZER_VERSIONS`, so an analyzer added without a
 * blurb still appears — with no description rather than being silently missing from the
 * list. Absent prose is obvious; an absent row is not.
 */
const ANALYZER_BLURBS: Record<string, string> = {
  "structural-lint": "Frontmatter, size, broken links, orphaned files.",
  "secret-scan": "Credentials committed into the bundle. Stored as fingerprints, never plaintext.",
  "prompt-injection": "Instructions aimed at the agent reading the skill rather than at its task.",
  "capability-surface": "What the bundled code can reach — network, files, shell, credentials.",
  "description-consistency": "Whether the documentation honestly describes the bundled code.",
};

const STATUSES = [
  {
    term: "Indexed",
    detail: "Passed validation and served. Everything you can browse is in this state.",
  },
  {
    term: "Quarantined",
    detail:
      "Failed a safety check. Kept with machine-readable reasons and visible on its own page, but excluded from search and never downloadable.",
  },
  {
    term: "Tombstoned",
    detail:
      "Gone from upstream. The content is withdrawn and the metadata kept, so existing links and citations still resolve.",
  },
  {
    term: "Withdrawn",
    detail:
      "Removed following a takedown request. The mirrored copy is deleted and the path is blocked from being fetched again.",
  },
];

/**
 * `id` is a `FaqAnchor`, not a string.
 *
 * Badges elsewhere link into these sections, so a renamed heading has to break the build
 * rather than quietly scroll nowhere.
 */
function Section({
  id,
  title,
  children,
}: {
  id: FaqAnchor;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="grid scroll-mt-6 gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{q}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">{children}</CardContent>
    </Card>
  );
}
