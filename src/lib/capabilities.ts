/**
 * What a skill's bundled code can reach (Doc 2 R2.4), in words a reader understands.
 *
 * A leaf module with no imports, because two very different callers need the same words:
 * the DAL, building filter labels on the server, and the capability card, rendering them on
 * the client. They had drifted — the detail page said "File read" while the registry filter
 * said "fs read", the raw enum with an underscore swapped for a space. One of those is a
 * label and the other is a variable name that leaked into the interface.
 *
 * The blurb matters as much as the label. "Shell" tells a reader nothing about whether they
 * should care; "Runs shell commands or subprocesses" does. These are the terms someone uses
 * to decide whether to install a skill, so they are written for that decision rather than
 * mirroring the analyzer's internals.
 *
 * Presented as description, never accusation: a deployment skill that runs shell commands is
 * doing its job. The thing worth flagging is a capability the documentation never mentions,
 * which is what `undocumented` and the R2.3 audit are for.
 */

export type CapabilityKey =
  | "network"
  | "fs_read"
  | "fs_write"
  | "shell"
  | "credentials";

export type CapabilityMeta = {
  /** Short, for a badge or a filter row. */
  label: string;
  /** One line, for a reader deciding whether it matters to them. */
  blurb: string;
};

export const CAPABILITY_META: Record<CapabilityKey, CapabilityMeta> = {
  network: {
    label: "Network access",
    blurb: "Makes outbound network requests",
  },
  fs_read: {
    label: "Reads files",
    blurb: "Reads files from disk",
  },
  fs_write: {
    label: "Writes files",
    blurb: "Creates, changes or deletes files",
  },
  shell: {
    label: "Runs commands",
    blurb: "Runs shell commands or subprocesses",
  },
  credentials: {
    label: "Reads credentials",
    blurb: "Reads environment variables or credential stores",
  },
};

/** Falls back to the raw key rather than hiding an analyzer we have not labelled yet. */
export function capabilityLabel(key: string): string {
  return CAPABILITY_META[key as CapabilityKey]?.label ?? key.replace(/_/g, " ");
}

export function capabilityBlurb(key: string): string {
  return CAPABILITY_META[key as CapabilityKey]?.blurb ?? "Detected capability";
}
