import type { ModelProfile } from "./model";
import type { ModelRequest, ModelResponse } from "./review";

/**
 * Optional model-call trace seam.
 * The extension supplies an OpenTelemetry-backed implementation.
 * Core only sees domain events and stays free of VS Code and OTel imports.
 */
export interface LlmTrace {
  /** The exact request about to be handed to the provider. */
  request(request: ModelRequest, profile: ModelProfile): void;
  /** The resolved process invocation. */
  process(args: readonly string[], cwd: string | undefined, pid: number | undefined): void;
  /** The prompt written to stdin. */
  stdin(text: string): void;
  /** Raw stdout from the provider process. */
  stdout(text: string): void;
  /** Raw stderr from the provider process. */
  stderr(text: string): void;
  /** The parsed provider response and the subprocess round-trip time. */
  response(response: ModelResponse, rttMs: number): void;
  /** A failed call, with the process facts that explain it. */
  error(error: unknown, rttMs: number, meta?: LlmErrorMeta): void;
}

/** Process facts attached to one failed model call. */
export interface LlmErrorMeta {
  exitCode?: string | number;
  signal?: string | null;
  killed?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  parseError?: boolean;
}
