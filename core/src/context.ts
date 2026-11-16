// Bounded, deterministic context plane for model calls (ticket #36).
// Pure Node/TypeScript only: no vscode import, no privacy import. The caller
// injects `redact` and the total budget; the assembler never reads settings.
import type { Range } from "./types";

/** Why a source produced no included fragments. */
export type OmitReason = "budget" | "empty" | "excluded" | "unsupported" | "error";

/** The kind of text a context fragment holds. */
export type ContextKind =
  | "selection"
  | "active-file"
  | "open-editor"
  | "git-diff"
  | "test-command"
  | "diagnostic"
  | "symbol"
  | "reference"
  | "definition"
  | "workspace-symbol"
  | "text-search"
  | "session";

/** Reserved source ids and their fixed priorities; ties break by id ascending. */
export type ContextSourceId =
  | "draft"
  | "qa"
  | "session-slice"
  | "selection"
  | "active-editor"
  | "open-editors"
  | "git-diff"
  | "diagnostics"
  | "symbols"
  | "references"
  | "definitions"
  | "workspace-symbols"
  | "test-command";

/** Fixed priorities from the lane's source table. Reserved ids only; #37 and #38 implement their rows. */
export const SOURCE_PRIORITIES: Record<ContextSourceId, number> = {
  draft: 100,
  qa: 90,
  "session-slice": 85,
  selection: 80,
  "active-editor": 70,
  "open-editors": 60,
  "git-diff": 50,
  diagnostics: 45,
  symbols: 40,
  references: 39,
  definitions: 38,
  "workspace-symbols": 37,
  "test-command": 30,
};

/** Where one fragment came from and how it was produced. */
export interface ContextProvenance {
  kind: ContextKind;
  /** Workspace-relative POSIX path, or "" for an untitled or virtual document. */
  path?: string;
  /** Character offsets of the excerpt inside its document, when known. */
  range?: Range;
  truncated: boolean;
  /** Extra fact from the producing collector, e.g. a failure detail. */
  reason?: string;
  /** Final included character count, set by the assembler after truncation. */
  chars: number;
  /** Secret matches replaced before this fragment reached the assembler, when the source redacted itself. */
  redactions?: number;
  /** String form of the workspace folder the collector resolved, when one exists. */
  folderUri?: string;
}

/** One bounded piece of context text, always post-redaction. */
export interface ContextFragment {
  /** Owning source id; the assembler overwrites it from the source. */
  source: string;
  /** Owning source priority; the assembler overwrites it from the source. */
  priority: number;
  content: string;
  tokens: number;
  provenance: ContextProvenance;
}

/** What one source's collect call produced. */
export interface ContextSourceResult {
  fragments: ContextFragment[];
  /** Set only when fragments is empty, so the manifest can explain the omission. */
  omittedReason?: OmitReason;
  /** Flat source-specific facts copied into the manifest entry. */
  details?: Record<string, string | number | boolean>;
}

/** One workspace context source. Implementations stay thin. */
export interface ContextSource {
  id: string;
  priority: number;
  /** Per-source token cap applied across this source's fragments before the total budget. */
  maxTokens?: number;
  collect(signal?: AbortSignal): Promise<ContextSourceResult>;
}

/** The assembler input: user text first, workspace sources second. */
export interface ContextInput {
  draft: string;
  qa: Array<{ question: string; answer: string }>;
}

/** One manifest row: how a source ended up in or out of the bundle. */
export interface ContextSourceEntry {
  /** The source id (or the extra-entry id, e.g. an #48 instruction file). */
  source: string;
  /** Final included character count, not the pre-truncation size. */
  chars: number;
  tokens: number;
  included: boolean;
  truncated: boolean;
  /** Set only when included is false. */
  omittedReason?: OmitReason;
  /** Secret matches replaced for this source, summed without double counting. */
  redactions: number;
  details?: Record<string, string | number | boolean>;
}

/** The traceable record of every assemble decision. */
export interface ContextManifest {
  /** Draft entry, qa entry, every source entry in sorted order, then extra entries sorted by id. */
  sources: ContextSourceEntry[];
  totalTokens: number;
  budget: number;
}

/** The full bounded bundle a model call consumes. */
export interface ContextBundle {
  /** Redacted draft, never truncated and never partial. */
  draft: string;
  /** Redacted Q&A, never truncated and never partial. */
  qa: Array<{ question: string; answer: string }>;
  /** Included workspace fragments in source order. */
  fragments: ContextFragment[];
  manifest: ContextManifest;
}

/** Result of one redaction pass: the final text and the number of matches replaced. */
export interface RedactResult {
  text: string;
  count: number;
}

export interface AssembleOptions {
  /** Total token budget for draft, Q&A and workspace sources combined. */
  budget: number;
  /** Injected token estimator; no tokenizer lives in core. */
  estimateTokens: (text: string) => number;
  /** Injected redaction, applied before every estimate and the returned content. */
  redact: (text: string) => RedactResult;
  /** #48 instruction entries: merged after source entries, sorted by id, not budgeted. */
  extraEntries?: ContextSourceEntry[];
  /** Caller signal passed to every collect; an abort rejects the whole assemble. */
  signal?: AbortSignal;
}

/** Cheap deterministic estimate: about one token per four characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sorts by priority descending, then source id ascending, without mutating the input. */
function sortSources(sources: ContextSource[]): ContextSource[] {
  return [...sources].sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The assembler's own abort error, so every caller sees the same code. */
function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

/** Rejects when the caller aborted; a cancelled assemble never returns a bundle. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/** Duplicate ids are a contract error, never a silent keep-the-last. */
function assertUniqueSources(sources: ContextSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.id === "draft" || source.id === "qa") {
      throw new Error(`source id "${source.id}" is reserved for the bundle fields; do not implement it as a ContextSource`);
    }
    if (seen.has(source.id)) throw new Error(`duplicate context source id "${source.id}"`);
    seen.add(source.id);
  }
}

/** A manifest entry for a source that produced nothing. */
function omittedEntry(source: ContextSource, reason: OmitReason, details?: ContextSourceResult["details"]): ContextSourceEntry {
  return { source: source.id, chars: 0, tokens: 0, included: false, truncated: false, omittedReason: reason, redactions: 0, ...(details ? { details } : {}) };
}

/** Truncates text to at most cap tokens, preferring a line boundary. Never mutates. */
function truncate(text: string, cap: number, estimate: (t: string) => number): string {
  if (cap <= 0) return "";
  const lines = text.split("\n");
  let prefix = "";
  for (let i = 0; i < lines.length; i++) {
    const next = i === 0 ? lines[0] : prefix + "\n" + lines[i];
    if (estimate(next) > cap) break;
    prefix = next;
  }
  if (prefix !== "" || (lines.length > 0 && estimate(lines[0]) <= cap)) return prefix;
  // No line boundary fits: cut at cap * 4 characters, then trim while over the cap.
  let cut = text.slice(0, Math.min(text.length, cap * 4));
  while (cut !== "" && estimate(cut) > cap) cut = cut.slice(0, -1);
  return cut;
}

/** One budget candidate: include whole, or truncate to the remaining cap. */
function fitFragment(
  content: string,
  cap: number,
  estimate: (t: string) => number,
): { content: string; tokens: number; truncated: boolean } {
  const tokens = estimate(content);
  if (tokens <= cap) return { content, tokens, truncated: false };
  if (cap <= 0) return { content: "", tokens: 0, truncated: true };
  const cut = truncate(content, cap, estimate);
  return { content: cut, tokens: estimate(cut), truncated: true };
}

/**
 * Builds the bounded context bundle: redact, estimate, allocate the budget in
 * priority order, truncate the last source that fits, omit and record the rest.
 * The draft and Q&A are a floor; the caller rejects a bundle whose floor alone
 * exceeds the budget.
 */
export async function assemble(input: ContextInput, sources: ContextSource[], options: AssembleOptions): Promise<ContextBundle> {
  const { budget, estimate, redact } = { ...options, estimate: options.estimateTokens };
  throwIfAborted(options.signal);
  assertUniqueSources(sources);

  // #48 extra entries must not collide with any manifest id, and never repeat one.
  const extraEntries = (options.extraEntries ?? []).map((entry) => ({ ...entry }));
  const usedIds = new Set<string>(["draft", "qa", ...sources.map((source) => source.id)]);
  const extraIds = new Set<string>();
  for (const entry of extraEntries) {
    if (usedIds.has(entry.source)) {
      throw new Error(`extra manifest entry source "${entry.source}" collides with a reserved or collected source id`);
    }
    if (extraIds.has(entry.source)) {
      throw new Error(`duplicate extra manifest entry source "${entry.source}"`);
    }
    extraIds.add(entry.source);
  }
  extraEntries.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  // Redact the user text first, then estimate; never return a partial draft or Q&A.
  const redactedDraft = redact(input.draft);
  const draftTokens = estimate(redactedDraft.text);
  const draftEntry: ContextSourceEntry = {
    source: "draft",
    chars: redactedDraft.text.length,
    tokens: draftTokens,
    included: true,
    truncated: false,
    redactions: redactedDraft.count,
  };
  let qaTokens = 0;
  let qaChars = 0;
  let qaRedactions = 0;
  const redactedQa: Array<{ question: string; answer: string }> = [];
  for (const item of input.qa) {
    const question = redact(item.question);
    const answer = redact(item.answer);
    redactedQa.push({ question: question.text, answer: answer.text });
    qaTokens += estimate(question.text) + estimate(answer.text);
    qaChars += question.text.length + answer.text.length;
    qaRedactions += question.count + answer.count;
  }
  const qaEntry: ContextSourceEntry = {
    source: "qa",
    chars: qaChars,
    tokens: qaTokens,
    included: true,
    truncated: false,
    redactions: qaRedactions,
  };

  // The user text is a floor: it is never truncated by the budget.
  let remaining = Math.max(0, budget - draftTokens - qaTokens);
  const entries: ContextSourceEntry[] = [draftEntry, qaEntry];
  const fragments: ContextFragment[] = [];

  // Every source is collected, even once the budget is spent, so the manifest
  // can explain each omission and an abort still rejects the whole assemble.
  for (const source of sortSources(sources)) {
    throwIfAborted(options.signal);
    let result: ContextSourceResult;
    try {
      result = await source.collect(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      entries.push(omittedEntry(source, "error"));
      continue;
    }
    throwIfAborted(options.signal);

    if (result.fragments.length === 0) {
      entries.push(omittedEntry(source, result.omittedReason ?? "empty", result.details));
      continue;
    }

    const includedFragments: ContextFragment[] = [];
    let truncated = false;
    let lostToCap = false;
    let chars = 0;
    let tokens = 0;
    let redactionCount = 0;
    let sourceCap = source.maxTokens ?? Number.POSITIVE_INFINITY;

    for (const fragment of result.fragments) {
      // An already-redacted fragment keeps its own count; never redact twice.
      let content: string;
      let count: number;
      if (fragment.provenance.redactions !== undefined) {
        content = fragment.content;
        count = fragment.provenance.redactions;
      } else {
        const applied = redact(fragment.content);
        content = applied.text;
        count = applied.count;
      }

      // The per-source cap runs before the total budget.
      const effectiveCap = Math.min(sourceCap, remaining);
      if (content === "") {
        // An empty fragment is never included; a zero cap means the budget left no room.
        if (effectiveCap <= 0) lostToCap = true;
        continue;
      }
      const capped = fitFragment(content, effectiveCap, options.estimateTokens);
      if (capped.truncated) {
        truncated = true;
        lostToCap = true;
      }
      sourceCap -= capped.tokens;
      if (capped.content === "") {
        // Nothing survived the cap or the budget: stop here; the rest is dropped.
        break;
      }

      remaining -= capped.tokens;
      includedFragments.push({
        source: source.id,
        priority: source.priority,
        content: capped.content,
        tokens: capped.tokens,
        provenance: {
          ...fragment.provenance,
          truncated: capped.truncated,
          chars: capped.content.length,
          redactions: count,
        },
      });
      chars += capped.content.length;
      tokens += capped.tokens;
      redactionCount += count;

      if (capped.truncated) break;
    }

    if (includedFragments.length === 0) {
      // Distinguish "the budget or a cap took the content" from "the source had nothing".
      entries.push(omittedEntry(source, lostToCap ? "budget" : "empty", result.details));
      continue;
    }
    fragments.push(...includedFragments);
    entries.push({
      source: source.id,
      chars,
      tokens,
      included: true,
      truncated,
      redactions: redactionCount,
      ...(result.details ? { details: result.details } : {}),
    });
  }

  throwIfAborted(options.signal);

  const totalTokens = draftTokens + qaTokens + entries.slice(2).reduce((sum, entry) => sum + (entry.included ? entry.tokens : 0), 0);
  const manifest: ContextManifest = { sources: [...entries, ...extraEntries], totalTokens, budget };
  return { draft: redactedDraft.text, qa: redactedQa, fragments, manifest };
}
