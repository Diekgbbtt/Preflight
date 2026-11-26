// Deep feedback contract (#46): ContextBundle in, persisted DeepReview out.
import { assemble, estimateTokens as defaultEstimate, type ContextManifest, type ContextSource, type ContextSourceEntry, type RedactResult } from "./context";
import { buildDeepPrompt, DEEP_PROMPT_VERSION, restoreMentions } from "./deepPrompt";
import { exceedsBudget, exceedsContext, mapError, type FeedbackError } from "./errors";
import type { ModelProvider } from "./model";
import type { Clock, Event, IdGenerator, Repository } from "./repository";
import { extractJson, parseDeepReview, type DeepReview } from "./schema";
import { SKIPPED_ANSWER } from "./questions";

/** One project instruction file, as #48's loader reports it. */
export interface InstructionFile {
  displayPath: string;
  relativePath: string;
  folder: string;
  bytes: number;
  tokens: number;
  included: boolean;
  truncated: boolean;
  redactions: number;
  /** "docs" for design and spec files (#18): their own block, same budget. Default "instructions". */
  kind?: "instructions" | "docs";
}

export interface InstructionBlock {
  text: string;
  files: InstructionFile[];
}

export interface InstructionLoaderConfig {
  instructionFileNames: string[];
  /** Design and spec files (#18 decision 4); opt-in. */
  designFileNames?: string[];
  /** includeCode is not "off", i.e. code-sharing consent was accepted. */
  shareCode: boolean;
}

/** Port implemented by #48 in the extension. */
export interface InstructionLoader {
  load(folders: string[], draft: string, config: InstructionLoaderConfig): Promise<InstructionBlock>;
}

/**
 * The derived session slice as the model saw it: the redacted, formatted fragment.
 * The full SessionSlice type lives in the extension; core stores only what was sent.
 */
export interface StoredSessionSlice {
  content: string;
  tokens: number;
  truncated: boolean;
}

/** reviews.jsonl payload. Envelope id = reviewId. */
export interface DeepReviewRecord extends DeepReview {
  draftId: string;
  /** Agent session id, as in SendRecord; not a feedback-session id. */
  sessionId?: string;
  contextManifest: ContextManifest;
  sessionSlice?: StoredSessionSlice;
}

/** questions.jsonl payload. Envelope id = questionId. #15 owns the fields; this is the assumed minimum. */
export interface Question {
  draftId: string;
  sessionId?: string;
  reviewId: string;
  question: string;
  why: string;
  options: string[];
  /** Set by a later event with the same id when the user answers. */
  answer?: { text: string; option?: number; answeredAt: string };
  /** Set by a later event with the same id when the user skips the question (#15). */
  skippedAt?: string;
}

export interface DeepFeedbackDeps {
  provider: ModelProvider;
  model: string;
  clock: Clock;
  ids: IdGenerator;
  reviews: Repository<DeepReviewRecord>;
  questions: Repository<Question>;
  /** Context sources for this draft (#18: T0 and T1 only). */
  sources(draft: string): ContextSource[] | Promise<ContextSource[]>;
  redact(text: string): RedactResult;
  estimateTokens?: (text: string) => number;
  /** Absent until #48 lands; then the call is made only when the provider supports it. */
  instructions?: InstructionLoader;
  instructionConfig?: InstructionLoaderConfig;
}

export interface DeepFeedbackInput {
  draftId: string;
  draft: string;
  /** Workspace folder URIs, in workspace order. */
  folders: string[];
  sessionId?: string;
}

export type DeepFeedbackResult = { ok: true; reviewId: string; review: DeepReviewRecord } | { ok: false; error: FeedbackError };

export const NO_INSTRUCTION_CONTROL_GAP = "provider cannot disable project-instruction auto-load";
export const INSTRUCTIONS_NOT_SHARED_GAP = "Project instruction files were not checked: code sharing is off.";

const tooLarge = (): FeedbackError => mapError(new Error("context is too large"));

/** Latest event per question id, in the order the questions were first asked. */
function latestQuestions(events: Array<Event<Question>>): Array<Event<Question>> {
  const byId = new Map<string, Event<Question>>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()];
}

/** Everything a deep review needs to continue a draft: the latest review and every question so far. */
export async function loadDeepSession(
  draftId: string,
  repos: { reviews: Repository<DeepReviewRecord>; questions: Repository<Question> },
): Promise<{ latest: Event<DeepReviewRecord> | null; questions: Array<Event<Question>> }> {
  const [reviews, questions] = await Promise.all([repos.reviews.byDraft(draftId), repos.questions.byDraft(draftId)]);
  return { latest: reviews.at(-1) ?? null, questions: latestQuestions(questions) };
}

/** Answered and skipped questions as Q&A for the assembler, oldest first. Untouched ones are not sent. */
export function qaFrom(questions: Array<Event<Question>>): Array<{ question: string; answer: string }> {
  return questions.flatMap((q) =>
    q.answer?.text.trim() ? [{ question: q.question, answer: q.answer.text }] : q.skippedAt ? [{ question: q.question, answer: SKIPPED_ANSWER }] : [],
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** User-facing names for source ids; unknown ids (e.g. "instructions:AGENTS.md") show their last part. */
const SOURCE_NAMES: Record<string, string> = {
  "prompt-files": "the referenced files",
  "git-diff": "the uncommitted changes",
  symbols: "the code outline",
  diagnostics: "the editor problems",
  "session-slice": "the agent session",
  "file-names": "the file list",
  "test-command": "the test command",
  qa: "earlier answers",
};
const sourceName = (id: string) => SOURCE_NAMES[id] ?? id.split(":").at(-1)!;

/**
 * Gaps the code can state with certainty, in plain words for the user.
 * A source that is merely empty (no session, no diff) is not a gap.
 */
export function manifestGaps(manifest: ContextManifest, supportsInstructionFiles: boolean): string[] {
  const gaps: string[] = [];
  if (!supportsInstructionFiles) gaps.push(NO_INSTRUCTION_CONTROL_GAP);
  for (const s of manifest.sources) {
    const d = s.details ?? {};
    if (s.source === "prompt-files") {
      const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : 0);
      if (n("missing")) gaps.push(`${n("missing")} referenced ${plural(n("missing"), "file was", "files were")} not found in the workspace`);
      if (n("ambiguous")) gaps.push(`${n("ambiguous")} referenced ${plural(n("ambiguous"), "file matches", "files match")} more than one workspace folder`);
      if (n("excluded")) gaps.push(`${n("excluded")} referenced ${plural(n("excluded"), "file was", "files were")} left out by the privacy settings`);
    }
    if (s.included && s.truncated) gaps.push(`Cut to fit the context budget: ${sourceName(s.source)}`);
    // The per-file counts above already explain an excluded prompt-files source.
    const explained = s.source === "prompt-files" && s.omittedReason === "excluded";
    if (!s.included && s.omittedReason && s.omittedReason !== "empty" && !explained) {
      const why = { budget: "the context budget was full", excluded: "the privacy settings exclude code", unsupported: "not available here", error: "could not be read" }[s.omittedReason];
      gaps.push(`Left out: ${sourceName(s.source)} (${why})`);
    }
  }
  return gaps;
}

function instructionEntries(files: InstructionFile[]): ContextSourceEntry[] {
  return files.map((f) => ({
    source: `${f.kind ?? "instructions"}:${f.displayPath}`,
    chars: f.included ? f.bytes : 0,
    tokens: f.included ? f.tokens : 0,
    included: f.included,
    truncated: f.truncated,
    ...(f.included ? {} : { omittedReason: "budget" as const }),
    redactions: f.redactions,
  }));
}

/** Appends the review and one event per question; returns the new review id. */
async function persist(review: DeepReviewRecord, input: DeepFeedbackInput, deps: DeepFeedbackDeps): Promise<{ reviewId: string; review: DeepReviewRecord }> {
  const reviewId = deps.ids();
  const ts = new Date(deps.clock.now()).toISOString();
  await deps.reviews.append({ id: reviewId, ts, ...review });
  for (const q of review.questions) {
    await deps.questions.append({
      id: deps.ids(),
      ts,
      draftId: input.draftId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      reviewId,
      question: q.question,
      why: q.why,
      options: q.options,
    });
  }
  return { reviewId, review };
}

export const EMPTY_DRAFT_QUESTION = { question: "What should the agent do?", why: "The draft is empty.", options: [] as string[] };

/** An empty draft needs no model: the only useful review is one question. Stored like any round. */
function emptyDraftReview(input: DeepFeedbackInput, budget: number): DeepReviewRecord {
  return {
    issues: [],
    questions: [EMPTY_DRAFT_QUESTION],
    assumptions: [],
    contextGaps: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    latency: 0,
    promptVersion: DEEP_PROMPT_VERSION,
    draftId: input.draftId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    contextManifest: { sources: [], totalTokens: 0, budget },
  };
}

/**
 * One deep round: load instructions, assemble the draft with every answered
 * question, check the budget, call the model once, parse, add code gaps, persist.
 */
export async function deepFeedback(input: DeepFeedbackInput, deps: DeepFeedbackDeps, signal?: AbortSignal): Promise<DeepFeedbackResult> {
  const caps = deps.provider.capabilities;
  const estimate = deps.estimateTokens ?? defaultEstimate;
  try {
    if (!input.draft.trim()) return { ok: true, ...(await persist(emptyDraftReview(input, caps.maxContextTokens), input, deps)) };
    const { questions } = await loadDeepSession(input.draftId, deps);

    let block: InstructionBlock = { text: "", files: [] };
    const instructionConfig = deps.instructionConfig ?? { instructionFileNames: [], shareCode: false };
    const instructionsSkipped = !!deps.instructions && caps.supportsInstructionFiles && !instructionConfig.shareCode;
    if (caps.supportsInstructionFiles && deps.instructions && instructionConfig.shareCode) {
      block = await deps.instructions.load(input.folders, input.draft, instructionConfig);
    }

    const bundle = await assemble({ draft: input.draft, qa: qaFrom(questions) }, await deps.sources(input.draft), {
      budget: caps.maxContextTokens,
      estimateTokens: estimate,
      redact: deps.redact,
      extraEntries: instructionEntries(block.files),
      signal,
    });
    const prompt = buildDeepPrompt({ bundle }, block.text);
    const promptTokens = bundle.manifest.totalTokens + estimate(prompt.system);
    if (exceedsBudget(bundle.manifest.totalTokens, bundle.manifest.budget) || exceedsContext(promptTokens, caps.maxContextTokens)) {
      return { ok: false, error: tooLarge() };
    }

    const started = deps.clock.now();
    const res = await deps.provider.complete({ system: prompt.system, user: prompt.user, model: deps.model }, signal);
    const latency = Math.max(0, deps.clock.now() - started);
    const text = restoreMentions(res.text);
    const raw = extractJson(text) as { issues?: unknown; questions?: unknown } | null;
    if (!raw || !Array.isArray(raw.issues) || !Array.isArray(raw.questions)) throw new SyntaxError("Invalid deep review JSON");

    const parsed = parseDeepReview(text, input.draft, {
      usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
      latency,
    });
    const slice = bundle.fragments.find((f) => f.source === "session-slice");
    const review: DeepReviewRecord = {
      ...parsed,
      promptVersion: prompt.promptVersion,
      contextGaps: [
        ...new Set([
          ...parsed.contextGaps,
          ...manifestGaps(bundle.manifest, caps.supportsInstructionFiles),
          ...(instructionsSkipped ? [INSTRUCTIONS_NOT_SHARED_GAP] : []),
        ]),
      ],
      draftId: input.draftId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      contextManifest: bundle.manifest,
      ...(slice ? { sessionSlice: { content: slice.content, tokens: slice.tokens, truncated: slice.provenance.truncated } } : {}),
    };
    return { ok: true, ...(await persist(review, input, deps)) };
  } catch (err) {
    return { ok: false, error: mapError(err) };
  }
}
