import { cn } from "@/lib/utils";

/**
 * The mark, inline rather than as an <img>, so the rings follow `currentColor` and the
 * core follows the theme's primary. One component, correct in light and dark.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="Skills Foundry"
      className={cn("size-6", className)}
    >
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeDasharray="210 41"
        transform="rotate(-70 50 50)"
      />
      <circle
        cx="50"
        cy="50"
        r="26"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeDasharray="130 33"
        transform="rotate(110 50 50)"
      />
      <circle cx="50" cy="50" r="10" className="fill-primary" />
    </svg>
  );
}

/**
 * Mark plus name. `nameClassName` lets a cramped spot (the home header on a small
 * phone) drop the name and keep the mark — the page itself carries the name below.
 */
export function Wordmark({
  className,
  nameClassName,
}: {
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Logo className="shrink-0" />
      <span className={cn("font-semibold tracking-tight whitespace-nowrap", nameClassName)}>
        Skills Foundry
      </span>
    </span>
  );
}
