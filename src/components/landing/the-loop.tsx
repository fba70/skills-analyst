import { RotateCcw } from "lucide-react";

/**
 * The loop, for a reader who has not read the specs.
 *
 * ## Why this is a list and not five cards
 *
 * The pillars above are three parallel claims and read correctly as columns. This is a
 * *sequence* — each stage consumes what the previous one produced, which is the whole
 * argument — and five columns inside `max-w-4xl` would be roughly 150px each, forcing the
 * bodies to two words a line and losing the ordering that is the point.
 *
 * ## The rail is drawn by the markers, not hung off a border
 *
 * The first version put a border on the list and hung each number over it with a negative
 * offset. That works until the marker grows: at 36px the circle reaches past the page's own
 * 16px padding and touches the viewport edge on a phone, and every size change means
 * recomputing the offset. So the marker column is a real column — circle, then a flexed
 * line filling whatever is left of the row — and the connector is centred by the layout
 * rather than by arithmetic. Nothing to recompute, nothing to overflow.
 *
 * ## The return leg is the section
 *
 * Ingest → Validate → Learn → Build → Assist is a pipeline, and a pipeline is what every
 * registry with a builder bolted on already has. What makes it a loop is the last row:
 * published skills and creation telemetry go back into the evidence the next author is
 * scaffolded from. It sits outside the sequence because it runs the other way.
 */
const stages = [
  {
    title: "Ingest",
    body: "Skills are synced from many sources into one schema. Each keeps its origin, its licence and a content hash — so what you download is provably the thing that was judged.",
  },
  {
    title: "Validate",
    body: "Security and quality analyzers run before anything is served, and they fail closed. Every verdict keeps the evidence it rests on and the version of the analyzer that produced it.",
  },
  {
    title: "Learn",
    body: "Structure is mined per function category. A section earns its place by the gap between good skills and the rest — not by being common, because something present everywhere is not advice.",
  },
  {
    title: "Build",
    body: "A new skill starts from that mined shape instead of a blank file, and is judged by the same analyzers the registry runs. No privileged path in.",
  },
  {
    title: "Assist",
    body: "The evidence stays visible while you write: which sections earned their place, by how much, and over how many distinct structures.",
  },
];

export function TheLoop() {
  return (
    <section className="grid gap-8">
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
          How the loop works
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Registries collect skills. Builders generate them. Neither learns from the other.
          Here every stage feeds the next, and the last one feeds the first.
        </p>
      </div>

      <ol className="grid">
        {stages.map(({ title, body }, index) => {
          const last = index === stages.length - 1;

          return (
            <li key={title} className="flex gap-4 sm:gap-5">
              <div className="flex flex-col items-center self-stretch">
                <span
                  aria-hidden
                  className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-base font-semibold tabular-nums sm:size-10 sm:text-lg"
                >
                  {index + 1}
                </span>
                {/* `flex-1` inside a stretched column is what makes the connector span the
                    row whatever the body's height, including the padding below it. */}
                {!last ? <span aria-hidden className="bg-border mt-2 w-px flex-1" /> : null}
              </div>

              <div className={`grid gap-1 ${last ? "" : "pb-8"}`}>
                <h3 className="pt-1 font-medium sm:pt-1.5">{title}</h3>
                <p className="text-muted-foreground max-w-2xl text-sm">{body}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="text-muted-foreground flex max-w-2xl items-start gap-3 text-sm">
        <RotateCcw className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Published skills, and what happened while they were written, go back into the
          evidence. Every skill created here improves the guidance the next author starts
          from — <span className="text-foreground">that return leg is the Skills Foundry product</span>,
          not the registry and not the builder.
        </span>
      </p>
    </section>
  );
}
