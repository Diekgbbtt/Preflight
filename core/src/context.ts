// Bounded, deterministic context plane for model calls (ticket #36).
// Pure Node/TypeScript only: no vscode import, no privacy import. The caller
// injects `redact` and the total budget; the assembler never reads settings.

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

/** Character offsets into the prompt, end exclusive. Same shape as core's Range. */
export interface ContextRange {
  start: number;
  end: number;
}

/** Where one fragment came from and how it was produced. */
export interface ContextProvenance {
  kind: ContextKind;
  /** Workspace-relative POSIX path, or "" for an untitled or virtual document. */
  path?: string;
  /** Character offsets of the excerpt inside its document, when known. */
  range?: ContextRange;
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
