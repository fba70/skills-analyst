import {
  FileDown,
  FileUp,
  Globe,
  KeyRound,
  ShieldQuestion,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * What the skill can reach (Doc 2 R2.4).
 *
 * Presented as description, not accusation: a skill that opens sockets is doing its job.
 * The thing worth highlighting is the *gap* — a capability the code has that the
 * documentation never mentions, which is the cheap approximation of the
 * description-behaviour consistency check.
 */

const CAPABILITIES: Record<string, { icon: LucideIcon; label: string; blurb: string }> = {
  network: { icon: Globe, label: "Network", blurb: "Makes outbound network requests" },
  fs_read: { icon: FileDown, label: "File read", blurb: "Reads files from disk" },
  fs_write: { icon: FileUp, label: "File write", blurb: "Creates, changes or deletes files" },
  shell: { icon: Terminal, label: "Shell", blurb: "Runs shell commands or subprocesses" },
  credentials: { icon: KeyRound, label: "Credentials", blurb: "Reads environment variables or credential stores" },
};

export function CapabilitySurface({
  surface,
  undocumented,
}: {
  surface: Record<string, { present: boolean; evidence: string[] }>;
  undocumented: string[];
}) {
  const present = Object.entries(surface).filter(([, value]) => value?.present);

  if (present.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No file, network, shell or credential access detected in bundled code.
      </p>
    );
  }

  return (
    <ul className="grid gap-3">
      {present.map(([key, value]) => {
        const meta = CAPABILITIES[key] ?? {
          icon: ShieldQuestion,
          label: key,
          blurb: "Detected capability",
        };
        const Icon = meta.icon;
        const isUndocumented = undocumented.includes(key);

        return (
          <li key={key} className="flex gap-3">
            <Icon
              className={cn(
                "mt-0.5 size-4 shrink-0",
                isUndocumented ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
              )}
            />
            <div className="min-w-0 grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{meta.label}</span>
                {isUndocumented ? (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400"
                  >
                    undocumented
                  </Badge>
                ) : null}
              </div>
              <p className="text-muted-foreground text-sm">{meta.blurb}</p>
              {value.evidence.length > 0 ? (
                <ul className="text-muted-foreground grid gap-0.5 font-mono text-xs">
                  {value.evidence.slice(0, 4).map((line) => (
                    /* Plain text, never a link: evidence can quote hostile content. */
                    <li key={line} className="truncate">
                      {line}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
