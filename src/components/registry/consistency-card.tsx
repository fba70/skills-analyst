import { AlertTriangle, ScanEye, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The description-vs-behaviour audit, rendered (Doc 2 R2.3).
 *
 * This is the most useful thing the validation pipeline produces for someone deciding
 * whether to install a skill, and it was invisible: the analyzer's verdict appeared as one
 * more row reading "description consistency · warn", while the actual finding — *this skill
 * streams a live activity feed to a Chrome extension and never says so* — sat unread inside
 * `evidence.data`.
 *
 * A `warn` here is normal and is presented as such. Under-documentation is the common case
 * and usually innocent, so the card leads with what the code does that the docs omit and
 * leaves the reader to judge. Only `concealment` — a mismatch that looks deliberate — is
 * given alarming treatment, because that is the one the analyzer is calibrated to be
 * confident about.
 */

const ANALYZER = "description-consistency";

export type ConsistencyCardProps = {
  verdicts: ReadonlyArray<{
    analyzer: string;
    result: string;
    data: Record<string, unknown>;
  }>;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function ConsistencyCard({ verdicts }: ConsistencyCardProps) {
  const verdict = verdicts.find((v) => v.analyzer === ANALYZER);
  // Not audited, or audited and found nothing to say. Either way there is nothing here
  // worth a card — an empty "no issues" panel is noise on a page that already has a
  // validation summary.
  if (!verdict) return null;

  const data = verdict.data ?? {};
  if (typeof data.skipped === "string") return null;

  const score = typeof data.consistencyScore === "number" ? data.consistencyScore : null;
  const undocumented = asStringArray(data.undocumentedCapabilities);
  const overclaimed = asStringArray(data.overclaimedBehaviour);
  const concealment = data.concealment === true;
  const rationale = typeof data.rationale === "string" ? data.rationale : null;

  if (undocumented.length === 0 && overclaimed.length === 0 && !concealment) return null;

  return (
    <Card className={concealment ? "border-destructive/50" : undefined}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {concealment ? (
            <ShieldAlert className="text-destructive size-4" />
          ) : (
            <ScanEye className="text-muted-foreground size-4" />
          )}
          Documentation vs. behaviour
          {score !== null ? (
            <Badge variant={concealment ? "destructive" : "outline"}>{score}/100</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {concealment
            ? "The mismatch between what this skill documents and what its code does appears deliberate. Treat it with suspicion."
            : "What the bundled code does, compared with what the documentation says. Gaps here are common and usually harmless — they are listed so the decision is yours."}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {undocumented.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="text-muted-foreground size-3.5" />
              Not mentioned in the documentation
            </h3>
            <ul className="grid gap-1.5">
              {undocumented.map((item) => (
                <li key={item} className="text-muted-foreground flex gap-2 text-sm">
                  <span aria-hidden className="text-muted-foreground/60 select-none">
                    &bull;
                  </span>
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {overclaimed.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Claimed but not found in the code</h3>
            <ul className="grid gap-1.5">
              {overclaimed.map((item) => (
                <li key={item} className="text-muted-foreground flex gap-2 text-sm">
                  <span aria-hidden className="text-muted-foreground/60 select-none">
                    &bull;
                  </span>
                  <span className="min-w-0">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {rationale ? (
          <p className="text-muted-foreground border-l-2 pl-3 text-xs italic">{rationale}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
