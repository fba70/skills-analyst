"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FilterOptions } from "@/server/dal/skills";

/**
 * Filters live in the URL, not in component state.
 *
 * That keeps the list a server component — the database does the filtering, sorting and
 * paging, and the page just renders the answer. It also makes any view shareable and the
 * back button behave, which client-side filter state does not.
 *
 * This component only ever rewrites the query string.
 */

const ALL = "__all__";

export type RegistryFiltersProps = {
  options: FilterOptions;
  pageSizes: readonly number[];
  sorts: Record<string, string>;
};

function SearchBox({
  initialValue,
  pending,
  onSearch,
}: {
  initialValue: string;
  pending: boolean;
  onSearch: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <form
      /*
       * Its own row, and it fills it.
       *
       * This used to share one wrapping flex row with the facet selects, capped at
       * `max-w-xs`. Each `SelectTrigger` carries `min-w-36`, so as facets were added the
       * box was squeezed to the search icon and nothing else — the hazard the previous
       * comment here already named, arriving again the moment a seventh facet landed.
       * Search is the primary control on this page and the facets are secondary, so the
       * layout now says so.
       */
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(value);
      }}
    >
      <div className="relative min-w-0 flex-1">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          name="q"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Search skills…"
          aria-label="Search skills"
          className="pl-9"
        />
        {pending ? (
          <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin" />
        ) : null}
      </div>
      {/*
       * A visible submit, because the only way to run a search was to press Enter in a
       * field that gave no sign it was part of a form. The behaviour is unchanged — the
       * button submits the same form the key already did — but a control with no
       * affordance reads as one that does not work, which is how it was reported.
       */}
      <Button type="submit" variant="secondary" disabled={pending}>
        Search
      </Button>
    </form>
  );
}

export function RegistryFilters({ options, pageSizes, sorts }: RegistryFiltersProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function apply(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || value === ALL) next.delete(key);
      else next.set(key, value);
    }
    // Any change but the page itself invalidates the current page number.
    if (!("page" in changes)) next.delete("page");
    startTransition(() => {
      router.push(next.toString() ? `/skills?${next}` : "/skills", { scroll: false });
    });
  }

  const facets: Array<{
    key: string;
    label: string;
    items: FilterOptions["sources"];
  }> = [
    /**
     * Function first, deliberately.
     *
     * It is the axis that says what a skill *does*, which is what someone browsing a
     * registry is usually after — and it is the axis archetypes are mined on, so the two
     * stay consistent. Domain follows. Source, licence, capability and dialect are
     * operator-shaped facets and sit after both.
     *
     * Both category selects write the same `category` parameter, carrying `axis:value`.
     * That means picking a domain replaces a function rather than intersecting with it,
     * which is the honest behaviour for one parameter; a real AND across axes needs two,
     * and is worth adding once coverage makes it useful.
     */
    { key: "category", label: "Any function", items: options.functions },
    { key: "category", label: "Any domain", items: options.domains },
    { key: "source", label: "All sources", items: options.sources },
    { key: "posture", label: "Any licence", items: options.postures },
    { key: "capability", label: "Any capability", items: options.capabilities },
    /*
     * Tools (Doc 7 RD.7). One select writes one `tool`, which is any-of over a list of one —
     * the URL parameter is a list because `listSkills` takes one and MCP callers send several,
     * and widening this control to multi-select later needs no change anywhere else.
     *
     * After capability, because the two answer the same shape of question about running a
     * skill and capability is the one the trust surface already established.
     */
    { key: "tool", label: "Any tool", items: options.tools },
    { key: "dialect", label: "Any dialect", items: options.dialects },
  ].filter((facet) => {
    /**
     * Hide a facet that cannot change the result set.
     *
     * Two cases, and the distinction matters. An **exhaustive** facet assigns every skill
     * exactly one value — dialect does — so when it has a single option covering the whole
     * corpus, choosing it returns precisely what no filter returns. That is what `dialect`
     * had become: every `agents_md` skill is currently quarantined or pending, so the only
     * option was "Anthropic skill" against all 2,556 results. A control whose sole setting
     * is a no-op reads as broken.
     *
     * A **partial** facet — capability — is different. Only 119 of 2,556 skills touch any
     * capability at all, so even one option genuinely narrows, and it stays.
     *
     * Comparing the option's count against the total is what tells the two apart, and it
     * self-corrects: the moment an `agents_md` skill passes validation, the dialect filter
     * comes back on its own.
     */
    if (facet.items.length === 0) return false;
    if (facet.items.length === 1 && facet.items[0].count >= options.total) return false;
    return true;
  });

  const active = facets.filter((facet) => params.get(facet.key));
  const hasFilters = active.length > 0 || Boolean(params.get("q"));

  return (
    <div className="grid gap-3">
      {/* Keyed on the URL value: when `q` changes from anywhere else — back button,
          Clear — the box remounts with the new value instead of syncing in an effect. */}
      <SearchBox
        key={params.get("q") ?? ""}
        initialValue={params.get("q") ?? ""}
        pending={isPending}
        onSearch={(value) => apply({ q: value })}
      />

      {/* Second row: the facets, and Clear, which resets the query as well as these. */}
      <div className="flex flex-wrap items-center gap-2">
        {facets.map((facet) => (
          <Select
            key={`${facet.key}-${facet.label}`}
            value={params.get(facet.key) ?? ALL}
            onValueChange={(value) => apply({ [facet.key]: value })}
          >
            <SelectTrigger size="sm" className="w-auto min-w-36">
              <SelectValue placeholder={facet.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{facet.label}</SelectItem>
              {facet.items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label} ({item.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => startTransition(() => router.push("/skills", { scroll: false }))}
          >
            <X className="size-4" />
            Clear
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-sm">Sort</span>
        <Select
          value={params.get("sort") ?? "quality"}
          onValueChange={(value) => apply({ sort: value === "quality" ? null : value })}
        >
          <SelectTrigger size="sm" className="w-auto min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(sorts).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground ml-2 text-sm">Show</span>
        <Select
          value={params.get("size") ?? "10"}
          onValueChange={(value) => apply({ size: value === "10" ? null : value })}
        >
          <SelectTrigger size="sm" className="w-auto min-w-20">
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
