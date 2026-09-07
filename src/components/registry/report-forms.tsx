"use client";

import { useState, useTransition } from "react";

import { toast } from "sonner";

import { flagSkillAction, submitTakedownAction } from "@/app/(public)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FLAG_REASON_META, FLAG_REASONS, MAX_FLAG_NOTE } from "@/lib/flags";

/**
 * The two things a reader with no account may say about a skill (R2.5, R7.5).
 *
 * ## Native `<details>`, not a dialog
 *
 * There is no dialog primitive vendored here, and adding one for this would be the wrong
 * trade. A `<details>` element is closed by default, keyboard-accessible without any work,
 * needs no focus trap, and — the part that matters on a public trust page — degrades to a
 * visible, usable form with JavaScript disabled or still loading. A reader who has spotted a
 * credential in a skill should not be waiting on a bundle.
 *
 * ## Both are quiet, and that is deliberate
 *
 * They sit at the bottom of the page as small text. A prominent "Report" button invites
 * idle clicking and fills a curator's queue with noise; a reader who has actually found
 * something will look for this, and a reader who has not should not be nudged into
 * inventing something.
 *
 * ## Neither promises an outcome
 *
 * Every message says what will and will not happen: recorded, read by a curator, nothing
 * hidden until they decide. Enforcing on arrival would let anybody who can fill in a form
 * un-list a competitor, and telling a reporter otherwise would be a promise the platform
 * deliberately does not keep.
 */

export function ReportForms({ slug, canTakedown }: { slug: string; canTakedown: boolean }) {
  return (
    <div className="text-muted-foreground grid gap-2 border-t pt-4 text-sm">
      <FlagForm slug={slug} />
      {/*
        A withdrawn skill already has no content, so a notice about it has nothing to act on
        and the queue should not fill with reports about things that are gone.
      */}
      {canTakedown ? <TakedownForm slug={slug} /> : null}
    </div>
  );
}

function FlagForm({ slug }: { slug: string }) {
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  function submit() {
    startTransition(async () => {
      const outcome = await flagSkillAction(slug, reason, note, contact);
      if (outcome.ok) {
        toast.success("Report sent", { description: outcome.message });
        setDone(true);
      } else {
        toast.error("Not sent", { description: outcome.message });
      }
    });
  }

  if (done) {
    return (
      <p className="text-sm">
        Thanks — a curator will look at this. Nothing about the skill has changed.
      </p>
    );
  }

  return (
    <details className="group">
      <summary className="hover:text-foreground cursor-pointer list-none underline underline-offset-4">
        Report a problem with this skill
      </summary>
      <div className="mt-3 grid max-w-xl gap-3">
        <p className="text-xs">
          A curator reads every report. Nothing is hidden, removed or re-scored until one
          decides — so a report is a request to look, not a takedown.
        </p>

        <fieldset className="grid gap-1.5">
          <legend className="text-foreground mb-1 text-sm font-medium">
            What did you find?
          </legend>
          {FLAG_REASONS.map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="reason"
                value={value}
                checked={reason === value}
                onChange={() => setReason(value)}
                className="mt-1"
              />
              <span>
                <span className="text-foreground">{FLAG_REASON_META[value].label}</span>
                <span className="block text-xs">{FLAG_REASON_META[value].blurb}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-1.5">
          <Label htmlFor={`note-${slug}`} className="text-sm">
            What should a curator look at? (optional)
          </Label>
          <textarea
            id={`note-${slug}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_FLAG_NOTE}
            rows={3}
            placeholder="Naming a file and a line is the most useful thing you can give us."
            className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-hidden focus-visible:ring-2"
          />
          {/*
            The cap is enforced on the server too. This attribute is a courtesy, not a
            constraint — a server action is a POST endpoint and the client cannot be trusted
            to have honoured it.
          */}
          <span className="text-xs">
            {note.length}/{MAX_FLAG_NOTE}
          </span>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`contact-${slug}`} className="text-sm">
            Your email (optional)
          </Label>
          <Input
            id={`contact-${slug}`}
            type="email"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
            placeholder="Only if you are happy to be asked a follow-up question"
          />
        </div>

        <div>
          <Button size="sm" onClick={submit} disabled={!reason || isPending}>
            {isPending ? "Sending…" : "Send report"}
          </Button>
        </div>
      </div>
    </details>
  );
}

const GROUNDS = [
  { value: "copyright", label: "Copyright" },
  { value: "license_violation", label: "Licence violation" },
  { value: "privacy", label: "Privacy" },
  { value: "trademark", label: "Trademark" },
  { value: "author_request", label: "I am the author and want it removed" },
  { value: "other", label: "Other" },
];

function TakedownForm({ slug }: { slug: string }) {
  const [requester, setRequester] = useState("");
  const [contact, setContact] = useState("");
  const [grounds, setGrounds] = useState("");
  const [claim, setClaim] = useState("");
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  function submit() {
    startTransition(async () => {
      const outcome = await submitTakedownAction(slug, requester, contact, grounds, claim);
      if (outcome.ok) {
        toast.success("Notice recorded", { description: outcome.message });
        setDone(true);
      } else {
        toast.error("Not recorded", { description: outcome.message });
      }
    });
  }

  if (done) {
    return <p className="text-sm">Your notice is recorded and awaiting review.</p>;
  }

  return (
    <details>
      <summary className="hover:text-foreground cursor-pointer list-none underline underline-offset-4">
        File a takedown notice
      </summary>
      <div className="mt-3 grid max-w-xl gap-3">
        <p className="text-xs">
          For rights-holders. This platform mirrors other people&rsquo;s work, and a notice is
          how you ask us to stop. Every notice is reviewed before anything is withheld, and
          the record is kept whether it is upheld or refused. Your name and address are never
          shown publicly, and the claim text is never republished.
        </p>

        <div className="grid gap-1.5">
          <Label htmlFor={`req-${slug}`} className="text-sm">
            Your name or organisation
          </Label>
          <Input
            id={`req-${slug}`}
            value={requester}
            onChange={(event) => setRequester(event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`reqmail-${slug}`} className="text-sm">
            Email we can reply to
          </Label>
          <Input
            id={`reqmail-${slug}`}
            type="email"
            value={contact}
            onChange={(event) => setContact(event.target.value)}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`grounds-${slug}`} className="text-sm">
            Grounds
          </Label>
          <select
            id={`grounds-${slug}`}
            value={grounds}
            onChange={(event) => setGrounds(event.target.value)}
            className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
          >
            <option value="">Choose…</option>
            {GROUNDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`claim-${slug}`} className="text-sm">
            The claim
          </Label>
          <textarea
            id={`claim-${slug}`}
            value={claim}
            onChange={(event) => setClaim(event.target.value)}
            rows={4}
            maxLength={4000}
            className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-hidden focus-visible:ring-2"
          />
        </div>

        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={submit}
            disabled={!requester || !contact || !grounds || !claim || isPending}
          >
            {isPending ? "Sending…" : "File notice"}
          </Button>
        </div>
      </div>
    </details>
  );
}
