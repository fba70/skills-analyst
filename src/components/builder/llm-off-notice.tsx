import { Sparkles } from "lucide-react";

import { LLM_OFF_DETAIL, LLM_OFF_HEADLINE } from "@/lib/llm-mode";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The one place a reader is told this deployment does not call models.
 *
 * ## Why it says it once, not on every control
 *
 * The switch is deployment-wide, so a note beside each of the eight surfaces it affects would
 * be the same sentence eight times — which reads as eight separate failures rather than one
 * configuration. The pages that own those surfaces hide the controls instead and render this
 * once, so the page says *this is off, here is what still works* and then gets out of the way.
 *
 * ## Not an error, and styled to say so
 *
 * Deliberately not `destructive`. A red card would tell a reader something has broken and
 * invite them to retry or to write in; nothing has broken, and the accurate posture is the
 * same one the budget notice takes at 60% — a fact about this deployment, stated calmly,
 * beside the list of what is unaffected.
 */
export function LlmOffNotice({ className }: { className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="flex gap-3 py-3 text-sm">
        <Sparkles className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        {/* min-w-0: the icon is a flex sibling, so without it the prose cannot wrap. */}
        <div className="grid min-w-0 gap-1">
          <p className="font-medium">{LLM_OFF_HEADLINE}</p>
          <p className="text-muted-foreground">{LLM_OFF_DETAIL}</p>
        </div>
      </CardContent>
    </Card>
  );
}
