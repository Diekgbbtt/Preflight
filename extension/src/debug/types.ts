import type { LlmTrace, ModelProfile } from "@prompt-preflight/core";

export type DebugLevel = "debug" | "info" | "warn" | "error";
export type LlmMode = "quick" | "deep" | "improve";
export type GenerationMethod = "cli";

export interface LlmTraceMeta {
  mode: LlmMode;
  generationMethod: GenerationMethod;
  timeoutMs: number;
}

export interface ReviewTraceMeta {
  mode: LlmMode;
  attempt: number;
  prompt: string;
  profile: ModelProfile;
}

export interface ReviewTrace {
  event(name: string, attributes?: Record<string, unknown>, level?: DebugLevel): void;
  health(
    cliPath: string,
    result: { ok: boolean; error?: { code: string; message: string } },
    rttMs: number,
  ): void;
  llm(meta: LlmTraceMeta): LlmTrace;
  parsed(review: unknown): void;
  error(error: unknown, mapped?: { code: string; action: string; retryable: boolean }): void;
  end(status?: "ok" | "error"): void;
}

export interface DebugTrace {
  startReview(meta: ReviewTraceMeta): ReviewTrace;
  event(name: string, attributes?: Record<string, unknown>, level?: DebugLevel): void;
  storage(action: string, attributes?: Record<string, unknown>): void;
  dispose(): Promise<void>;
}

export const NOOP_LLM_TRACE: LlmTrace = {
  request: () => undefined,
  process: () => undefined,
  stdin: () => undefined,
  stdout: () => undefined,
  stderr: () => undefined,
  response: () => undefined,
  error: () => undefined,
};

export const NOOP_REVIEW_TRACE: ReviewTrace = {
  event: () => undefined,
  health: () => undefined,
  llm: () => NOOP_LLM_TRACE,
  parsed: () => undefined,
  error: () => undefined,
  end: () => undefined,
};

export const NOOP_DEBUG_TRACE: DebugTrace = {
  startReview: () => NOOP_REVIEW_TRACE,
  event: () => undefined,
  storage: () => undefined,
  dispose: () => Promise.resolve(),
};
