"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, type ReactNode } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Tab and page-size selection, both held in the URL.
 *
 * The tab lives there rather than in component state so that paging a queue does not
 * navigate you back to the first tab, and so any view is linkable. It also lets the page
 * query only the visible tab instead of all five lists on every render.
 *
 * Radix `Tabs` is kept — driven by the URL rather than replaced by it. A hand-rolled
 * `role="tablist"` looked identical and silently dropped arrow-key navigation,
 * `aria-controls` wiring and roving tabindex. Controlling Radix keeps that behaviour and
 * still puts the state in the URL.
 */

export function SettingsTabs({
  active,
  tabs,
  children,
}: {
  active: string;
  tabs: Array<{ value: string; label: string }>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  return (
    /* min-w-0: grid and flex children default to min-width:auto, so without it the tab
       strip's intrinsic width wins and the whole page grows instead of the strip
       scrolling. */
    <Tabs
      className="min-w-0"
      value={active}
      onValueChange={(value) =>
        startTransition(() =>
          // Switching tab drops page and size: they belong to the list you just left.
          router.push(value === "ingestion" ? "/settings" : `/settings?tab=${value}`, {
            scroll: false,
          }),
        )
      }
    >
      {/*
        Seven tabs do not fit at 375px. They scroll inside their own strip rather than
        widening the page — a body that scrolls sideways is never the right answer.

        `overflow-y-hidden` is not redundant. Per the CSS overflow spec, when one axis is
        set to something other than `visible` the other axis computes to `auto` rather than
        staying `visible` — so `overflow-x-auto` alone silently enables vertical scrolling
        too. The triggers sit at `h-[calc(100%-1px)]` inside a padded list, and that is
        enough sub-pixel overflow to raise a vertical scrollbar on a strip that has nothing
        to scroll vertically.
      */}
      <TabsList className="max-w-full justify-start overflow-x-auto overflow-y-hidden">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} className="shrink-0">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* Only the active panel exists — its data is the only data fetched. */}
      <TabsContent value={active} className="mt-4">
        {children}
      </TabsContent>
    </Tabs>
  );
}

export function ListControls({
  pageSizes,
  showing,
  total,
}: {
  pageSizes: readonly number[];
  showing: { first: number; last: number };
  total: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function setSize(size: string) {
    const next = new URLSearchParams(params.toString());
    if (size === "10") next.delete("size");
    else next.set("size", size);
    // A different page size invalidates the page number.
    next.delete("page");
    startTransition(() => router.push(`/settings?${next}`, { scroll: false }));
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {total === 0
          ? "Nothing to show"
          : `Showing ${showing.first}–${showing.last} of ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">Show</span>
        <Select value={params.get("size") ?? "10"} onValueChange={setSize} disabled={isPending}>
          <SelectTrigger size="sm" className="w-auto min-w-20" aria-label="Items per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizes.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-sm">per page</span>
      </div>
    </div>
  );
}
