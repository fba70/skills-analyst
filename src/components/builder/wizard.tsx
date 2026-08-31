"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  loadScaffoldAction,
  submitDraftAction,
} from "@/app/(protected)/build/actions";
import type { Scaffold } from "@/server/builder/scaffold";
import { DOMAINS } from "@/server/taxonomy/vocabulary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The builder (Doc 2 R4.1, R4.3).
 *
 * Four steps, in the order the information actually arrives: what kind of skill, what it is
 * for, what is specific to you, then the sections themselves. The shape of the last step is
 * not ours — it comes from the mined archetype for the category chosen in the first, which
 * is the whole point of R4.1. A builder that asked "which sections would you like?" would
 * be a blank page with a progress bar.
 *
 * ## Every prompt shows its evidence
 *
 * R5.2's acceptance criterion says a suggestion must be traceable to the archetype element
 * it came from, and that the assistant never asserts a corpus fact without a retrievable
 * source. So each section field carries its prevalence in both bands, and the header says
 * how many distinct structures the skeleton was derived from. "Add a troubleshooting
 * section" is an opinion; "28% of well-regarded skills here have one, against 5% of the
 * rest" is a finding the reader can go and check.
 *
 * ## Nothing is required except the purpose
 *
 * Sections left empty are written from the purpose rather than refused. An author who
 * cannot yet articulate their error-handling section still gets a draft with one, which is
 * a better starting point than a form that will not submit.
 */

type Category = { id: string; label: string; description: string; hasArchetype: boolean };

const DIALECTS = [
  { id: "anthropic_skill", label: "SKILL.md (Claude, Agent Skills standard)" },
  { id: "agents_md", label: "AGENTS.md" },
  { id: "cursor_rule", label: "Cursor rule" },
] as const;

export function BuilderWizard({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [category, setCategory] = useState<Category | null>(null);
  const [scaffold, setScaffold] = useState<Scaffold | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [context, setContext] = useState("");
  const [dialect, setDialect] = useState<string>("anthropic_skill");
  const [domain, setDomain] = useState<string>("");
  const [sectionInputs, setSectionInputs] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function chooseCategory(next: Category) {
    startTransition(async () => {
      const result = await loadScaffoldAction(next.id);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setCategory(next);
      setScaffold(result.data);
      setStep(1);
    });
  }

  function submit() {
    if (!category) return;
    startTransition(async () => {
      const result = await submitDraftAction({
        name,
        purpose,
        context,
        category: category.id,
        domain,
        dialect,
        sectionInputs,
      });

      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.data.refused) {
        // A refusal is a real answer, not an error — the draft exists and says why.
        toast.warning("The assistant declined to write this one.");
      } else {
        toast.success("Draft written.");
      }
      router.push(`/build/${result.data.draftId}`);
    });
  }

  return (
    <div className="grid gap-4">
      <Steps current={step} />

      {step === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What kind of skill is it?</CardTitle>
            <CardDescription>
              This decides the shape. Each category has a skeleton mined from the skills in
              it that work, and the rest of this form follows that skeleton.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {categories.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => chooseCategory(row)}
                    className="hover:border-primary/50 focus-visible:ring-ring grid w-full gap-1 rounded-lg border p-3 text-left transition-colors outline-hidden focus-visible:ring-2 disabled:opacity-50"
                  >
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {row.label}
                      {!row.hasArchetype ? (
                        // Said plainly rather than hidden: the builder still works, it just
                        // has no measured evidence to offer for this category yet.
                        <Badge variant="outline" className="text-[11px] font-normal">
                          no archetype yet
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {row.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {step === 1 && scaffold ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What does it do?</CardTitle>
            <CardDescription>
              The purpose is the one thing the assistant cannot infer. Everything else has a
              sensible default; this does not.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="b-name">Name</Label>
              <Input
                id="b-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Django performance review"
                autoFocus
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="b-purpose">What is it for, and when should an agent use it?</Label>
              <Textarea
                id="b-purpose"
                rows={4}
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Reviews Django code for N+1 queries and slow ORM patterns. Use when someone asks to check query performance before a release."
              />
              {scaffold.norms.medianDescriptionLength > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Skills in this category describe themselves in about{" "}
                  {scaffold.norms.medianDescriptionLength} characters.
                </p>
              ) : null}
            </div>

            {/*
              Domain sits here rather than in a step of its own.
              
              It does not change the shape — archetypes are mined on the function axis
              alone, so a contract review and a pull-request review share a skeleton. What
              it changes is vocabulary, and what it enables is categorisation on the axis
              people actually browse by. A whole step for one optional dropdown would be
              friction for no gain.
            */}
            <div className="grid gap-1.5">
              <Label htmlFor="b-domain">Field it serves</Label>
              <select
                id="b-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              >
                <option value="">Not specific to one field</option>
                {DOMAINS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-xs">
                Optional. This does not change the sections — those come from the category
                you picked. It shapes the wording and examples, and it is how the skill is
                filed once published.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="b-dialect">Target format</Label>
              <select
                id="b-dialect"
                value={dialect}
                onChange={(e) => setDialect(e.target.value)}
                className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px]"
              >
                {DIALECTS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <Nav
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextDisabled={!name.trim() || purpose.trim().length < 20}
            />
          </CardContent>
        </Card>
      ) : null}

      {step === 2 && scaffold ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Anything specific to you?</CardTitle>
            <CardDescription>
              Your workflow, house rules, tools you already use, things the skill must never
              do. This is merged into the draft without changing its shape (R4.3) — and
              anything you leave out is simply not invented.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Textarea
              rows={6}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={
                "We run pytest with pytest-django. Never suggest raw SQL. Reports go in a\nmarkdown table with severity, file:line and a suggested fix."
              }
            />
            <Nav onBack={() => setStep(1)} onNext={() => setStep(3)} />
          </CardContent>
        </Card>
      ) : null}

      {step === 3 && scaffold ? (
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">The sections</CardTitle>
              <CardDescription>
                {scaffold.evidence ? (
                  <>
                    This shape is derived from{" "}
                    {scaffold.evidence.structures.toLocaleString()} distinct document
                    structures across {scaffold.evidence.sources} sources — the archetype for{" "}
                    {scaffold.categoryLabel.toLowerCase()} (v{scaffold.archetypeVersion}).
                    Percentages are how often each section appears in well-regarded skills
                    against everything else.
                  </>
                ) : (
                  <>
                    No archetype has been mined for this category yet, so this is a plain
                    skeleton rather than a measured one. Nothing below claims corpus support.
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              {scaffold.sections.map((section) => (
                <div key={section.role} className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Label htmlFor={`s-${section.role}`}>{section.label}</Label>
                    {section.required ? (
                      <Badge variant="secondary" className="text-[11px]">
                        expected
                      </Badge>
                    ) : null}
                    {section.lift !== null ? (
                      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
                        {section.strongPrevalence}% / {section.weakPrevalence}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground ml-auto text-xs">standard</span>
                    )}
                  </div>
                  <p className="text-muted-foreground text-xs">{section.blurb}</p>
                  <Textarea
                    id={`s-${section.role}`}
                    rows={3}
                    value={sectionInputs[section.role] ?? ""}
                    onChange={(e) =>
                      setSectionInputs((prev) => ({ ...prev, [section.role]: e.target.value }))
                    }
                    placeholder="Notes, or leave blank and it will be written from the purpose."
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          {scaffold.traits.length > 0 || scaffold.exemplars.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What works in this category</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                {scaffold.traits.length > 0 ? (
                  <ul className="grid gap-1">
                    {scaffold.traits.slice(0, 5).map((trait) => (
                      <li
                        key={trait.label}
                        className="flex items-baseline justify-between gap-3 text-sm"
                      >
                        <span>{trait.label}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                          {trait.strongPrevalence}% / {trait.weakPrevalence}%
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {scaffold.exemplars.length > 0 ? (
                  <div className="grid gap-1 border-t pt-3">
                    <p className="text-muted-foreground text-xs">
                      Licence-clean examples worth reading first:
                    </p>
                    <ul className="flex flex-wrap gap-2">
                      {scaffold.exemplars.slice(0, 5).map((skill) => (
                        <li key={skill.id}>
                          <a
                            href={`/skills/${skill.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-foreground text-muted-foreground text-xs underline underline-offset-4"
                          >
                            {skill.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setStep(2)} disabled={isPending}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button onClick={submit} disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Write the draft
            </Button>
            <span className="text-muted-foreground text-xs">
              One model call. Your inputs are saved first, so a failure costs the draft and
              not your typing.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const STEP_LABELS = ["Category", "Purpose", "Your context", "Sections"];

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {STEP_LABELS.map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={
              index === current
                ? "text-foreground font-medium"
                : index < current
                  ? "text-muted-foreground"
                  : "text-muted-foreground/50"
            }
          >
            {index + 1}. {label}
          </span>
          {index < STEP_LABELS.length - 1 ? (
            <span className="text-muted-foreground/40" aria-hidden>
              /
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Nav({
  onBack,
  onNext,
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        Back
      </Button>
      <Button size="sm" onClick={onNext} disabled={nextDisabled}>
        Next
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

/** There is no shadcn textarea vendored, and one field's worth of classes is not a component. */
function Textarea(props: React.ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className="border-input bg-transparent placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px]"
    />
  );
}
