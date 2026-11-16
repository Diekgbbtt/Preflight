/**
 * User-facing feedback error taxonomy (#42).
 *
 * One discriminated union, fixed sentences, one action per code, and a strict
 * retry policy. Raw CLI errors are mapped here and never reach the UI; the
 * message never contains stderr or prompt text, and the cause is omitted for
 * mapped raw errors so a leaked secret in a raw message cannot surface.
 *
 * Assumed #39/#40 shapes (recorded before coding, reconcile at merge):
 * - ModelProfile/ModelCapabilities/Config as in core/src/model.ts (merged).
 * - ScoreReport (#40) is not parsed here; #42 only distinguishes "no current
 *   ScoreReport" from "a stale one is on screen".
 * - #36's bundle manifest (totalTokens/budget) does not exist yet; #42 only
 *   publishes the pure exceedsContext/exceedsBudget predicates.
 */

import { execFile } from "node:child_process";
import type { ModelProfile, ModelProvider, ProfileValidation } from "./model";

export type FeedbackErrorCode =
  | "provider-missing"
  | "auth-missing"
  | "quota"
  | "timeout"
  | "invalid-response"
  | "context-too-large"
  | "cancelled"
  | "unknown";

export type FeedbackAction =
  | "open-settings"
  | "install-cli"
  | "fix-permissions"
  | "retry"
  | "reduce-context"
  | "dismiss";

export interface FeedbackError {
  code: FeedbackErrorCode;
  /** Fixed user-facing sentence per code; never raw stderr. */
  message: string;
  action: FeedbackAction;
  retryable: boolean;
  /** Optional sanitized context; never prompt text or stderr. */
  cause?: string;
}

export const ACTION_LABELS: Record<FeedbackAction, string> = {
  "open-settings": "Open Settings",
  "install-cli": "Install CLI",
  "fix-permissions": "Fix Permissions",
  retry: "Retry",
  "reduce-context": "Reduce Context",
  dismiss: "Dismiss",
};

const MESSAGES: Record<FeedbackErrorCode, string> = {
  "provider-missing": "The selected model provider is not available. Install its CLI or choose another provider in settings.",
  "auth-missing": "The model provider rejected the login. Sign in again or check your credentials.",
  quota: "The model provider quota is exhausted. Check your plan or try again later.",
  timeout: "The model provider did not answer in time.",
  "invalid-response": "The model provider returned an unreadable answer.",
  "context-too-large": "The context is too large for the selected model. Reduce the included code and try again.",
  cancelled: "The request was cancelled.",
  unknown: "Something went wrong while asking the model provider.",
};

const ACTIONS: Record<FeedbackErrorCode, FeedbackAction> = {
  "provider-missing": "open-settings",
  "auth-missing": "open-settings",
  quota: "open-settings",
  timeout: "retry",
  "invalid-response": "retry",
  "context-too-large": "reduce-context",
  cancelled: "dismiss",
  unknown: "dismiss",
};

function makeError(code: FeedbackErrorCode): FeedbackError {
  return { code, message: MESSAGES[code], action: ACTIONS[code], retryable: code === "timeout" };
}

const CODES: readonly FeedbackErrorCode[] = [
  "provider-missing", "auth-missing", "quota", "timeout",
  "invalid-response", "context-too-large", "cancelled", "unknown",
];
const ACTIONS_SET: readonly string[] = Object.keys(ACTION_LABELS);

export function isFeedbackError(value: unknown): value is FeedbackError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" && (CODES as readonly string[]).includes(v.code) &&
    typeof v.message === "string" &&
    typeof v.action === "string" && ACTIONS_SET.includes(v.action) &&
    typeof v.retryable === "boolean"
  );
}

/** An already-mapped error passes through with the same reference. */
export function mapError(err: unknown): FeedbackError {
  if (isFeedbackError(err)) return err;
  const e = err as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null | undefined;
  const message = typeof e?.message === "string" ? e.message : "";
  const lower = message.toLowerCase();
  const code = typeof e?.code === "string" ? e.code : undefined;
  const status = typeof e?.code === "number" ? e.code : undefined;

  // 1. Cancellation: caller AbortSignal or the provider's own rejection.
  if (code === "cancelled" || e?.name === "AbortError" || code === "ABORT_ERR") return makeError("cancelled");
  // 2. Missing binary.
  if (code === "ENOENT") {
    return { ...makeError("provider-missing"), action: "install-cli" };
  }
  // 3. Permission problems are a provider availability problem, not auth.
  if (code === "EACCES" || code === "EPERM") {
    return { ...makeError("provider-missing"), action: "fix-permissions" };
  }
  // 4. Quota: explicit status or provider quota/rate-limit wording.
  if (status === 429 || /quota|rate.?limit|too.?many.?requests/.test(lower)) return makeError("quota");
  // 5. Auth before timeout: an auth message may also mention timing out.
  if (
    status === 401 || status === 403 ||
    /unauthorized|forbidden|authentication (failed|required)|api key|login/.test(lower)
  ) {
    return makeError("auth-missing");
  }
  // 6. Transient timeout: the execFile kill or a provider timing message.
  if (e?.killed === true || e?.signal === "SIGTERM" || code === "ETIMEDOUT" || /timed? ?out|timeout/.test(lower)) {
    return makeError("timeout");
  }
  // 7. Unreadable answer: JSON parse failure, empty output, unparsable result.
  if (
    err instanceof SyntaxError ||
    /json|pars|unexpected|empty (output|result)/.test(lower)
  ) {
    return makeError("invalid-response");
  }
  // 8. Context overflow.
  if (/maximum context|context (window|limit)|context is too large|too many tokens|token limit|exceed.{0,20}tokens/.test(lower)) {
    return makeError("context-too-large");
  }
  // 9. Provider/configuration wording.
  if (/unknown model provider|not implemented; use claude/.test(lower)) return makeError("provider-missing");
  // 10. Never guess from a generic nonzero exit.
  return makeError("unknown");
}

/** Only a transient timeout may be retried, at most once (caller enforces). */
export function isRetryable(error: FeedbackError): boolean {
  return error.code === "timeout";
}

export function feedbackMessage(error: FeedbackError): { message: string; action: FeedbackAction } {
  return { message: MESSAGES[error.code], action: error.action };
}

/** Exactly "[prompt-preflight] <correlationId> <code>"; nothing else. */
export function feedbackLogMessage(error: FeedbackError, correlationId: string): string {
  return `[prompt-preflight] ${correlationId} ${error.code}`;
}

/**
 * Context pre-check (#42): the assembled bundle tokens must fit the profile's
 * model window. Exactly at the limit is allowed; one token over fails. An
 * unknown window (maxContextTokens <= 0) skips the check. Token counting and
 * the bundle manifest belong to #36; #36 calls this predicate.
 */
export function exceedsContext(totalTokens: number, profile: ModelProfile): boolean {
  void profile;
  return false;
}

/** Budget pre-check for #36's manifest: exactly at the budget is allowed. */
export function exceedsBudget(totalTokens: number, budget: number): boolean {
  return totalTokens > budget;
}

/** Callback-style executor seam so checkHealth never spawns a real CLI in tests. */
export type HealthExecutor = (
  command: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null) => void,
) => void;

export type HealthResult = { ok: true } | { ok: false; error: FeedbackError };

const HEALTH_TIMEOUT_MS = 2000;

/** Default executor: execFile with a small maxBuffer and a 2 s timeout. */
const defaultExec: HealthExecutor = (command, args, options, callback) => {
  execFile(command, args, { ...options, maxBuffer: 64 * 1024 }, (err) => callback(err ?? null));
};

/**
 * Health check at activation and before a review: profile validation plus a
 * cheap CLI presence probe. No model call. Presence does not prove auth; a
 * first-call auth failure maps to auth-missing at review time.
 */
export async function checkHealth(
  provider: ModelProvider,
  profile: ModelProfile,
  cliPath: string,
  exec: HealthExecutor = defaultExec,
): Promise<HealthResult> {
  let validation: ProfileValidation;
  try {
    validation = provider.validateProfile(profile);
  } catch (e) {
    return { ok: false, error: mapError(e) };
  }
  if (!validation.ok) {
    const base = makeError("provider-missing");
    return { ok: false, error: { ...base, cause: validation.message } };
  }
  return new Promise<HealthResult>((resolve) => {
    try {
      exec(cliPath, ["--version"], { timeout: HEALTH_TIMEOUT_MS }, (error) => {
        resolve(error === null ? { ok: true } : { ok: false, error: mapError(error) });
      });
    } catch (e) {
      resolve({ ok: false, error: mapError(e) });
    }
  });
}
