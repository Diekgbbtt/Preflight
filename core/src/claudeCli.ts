import { execFile } from "node:child_process";
import type { ModelRequest, ModelResponse, ModelRunner } from "./review";
import type { ModelCapabilities, ModelProfile, ModelProvider, ProfileValidation, ThinkingEffort } from "./model";
import type { LlmErrorMeta, LlmTrace } from "./observability";

export const CLAUDE_TIMEOUT_MS = 120_000;

/**
 * Pure argument builder: the result is a string[] passed straight to execFile,
 * so there is no shell interpolation. The user prompt goes on stdin, not here.
 */
export function buildClaudeArgs(request: ModelRequest, profile: ModelProfile): string[] {
  return [
    "-p",
    "--model", profile.model,
    "--effort", profile.thinkingEffort,
    "--output-format", "json",
    "--tools", "",
    "--setting-sources", "",
    "--system-prompt", request.system,
  ];
}

/** Module-private: the public seam is provider.validateProfile(profile). */
function validateClaudeProfile(profile: ModelProfile): ProfileValidation {
  if (profile.provider !== "claude") {
    return { ok: false, message: `Provider "${String(profile.provider)}" is not claude; the Claude adapter only accepts claude profiles.` };
  }
  if (profile.model.trim() === "") return { ok: false, message: "Model must not be empty." };
  if (profile.thinkingEffort.trim() === "") return { ok: false, message: "Thinking effort must not be empty." };
  return { ok: true };
}

/**
 * Claude capability values.
 * Prices are USD per million tokens. Source, accessed 2026-11-16:
 * https://platform.claude.com/docs/en/about-claude/pricing
 * (Claude Haiku 5.5 base tier, Claude Sonnet 5.5, Claude Opus 5.5).
 * Gap: an unknown model name gets zero cost rather than an invented price.
 * maxContextTokens is pinned to 200000 by lane brief 8.4 even though current
 * published model windows are larger; revisit when #42 needs the real window.
 */
function claudeModelCost(model: string): ModelCapabilities["cost"] {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return { inputPerMTok: 0.1, outputPerMTok: 0.5 };
  if (m.includes("sonnet")) return { inputPerMTok: 2, outputPerMTok: 10 };
  if (m.includes("opus")) return { inputPerMTok: 4, outputPerMTok: 20 };
  return { inputPerMTok: 0, outputPerMTok: 0 };
}

export function createClaudeProvider(profile: ModelProfile, config: { claudePath: string; trace?: LlmTrace }): ModelProvider {
  return {
    capabilities: {
      // The CLI exposes --json-schema; #40 does not export a JSON Schema yet,
      // so no schema argument is built. Follow-up tracked in the ticket ledger.
      structuredOutput: true,
      thinkingEffort: true,
      maxContextTokens: 200_000,
      cost: claudeModelCost(profile.model),
      // --setting-sources "" disables instruction-file auto-load, so the caller
      // decides what to include (#46 calls the #48 loader itself).
      supportsInstructionFiles: true,
    },
    validateProfile: validateClaudeProfile,
    complete: (request, signal) => execClaude({ claudePath: config.claudePath, trace: config.trace }, request, profile, signal),
  };
}

function cancelledError(): Error {
  return Object.assign(new Error("cancelled"), { code: "cancelled" });
}

/**
 * Shared spawn runner: one execFile call for both the provider path and the
 * legacy panel runner. The prompt goes over stdin so it can't be mistaken for
 * a flag and has no length limit. No retries; #42 owns retry.
 */
function execClaude(
  opts: { claudePath: string; cwd?: string; trace?: LlmTrace },
  request: ModelRequest,
  profile: ModelProfile,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  if (request.model !== profile.model) {
    const mismatch = new Error(
      `Model mismatch: request model "${request.model}" does not match the profile model "${profile.model}".`,
    );
    opts.trace?.error(mismatch, 0);
    return Promise.reject(mismatch);
  }
  if (signal?.aborted) {
    const cancelled = cancelledError();
    opts.trace?.error(cancelled, 0, { aborted: true });
    return Promise.reject(cancelled);
  }
  return new Promise<ModelResponse>((resolve, reject) => {
    const startedAt = performance.now();
    const args = buildClaudeArgs(request, profile);
    opts.trace?.request(request, profile);
    const child = execFile(
      opts.claudePath,
      args,
      { cwd: opts.cwd, signal, timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const rttMs = performance.now() - startedAt;
        opts.trace?.stdout(stdout);
        if (stderr) opts.trace?.stderr(stderr);
        if (err) {
          if (signal?.aborted || err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
            const cancelled = cancelledError();
            opts.trace?.error(cancelled, rttMs, { aborted: true });
            return reject(cancelled);
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            const missing: Error & { code?: string } = new Error(
              `Claude Code CLI not found at "${opts.claudePath}". Install it or set promptPreflight.claudePath.`,
            );
            missing.code = code;
            opts.trace?.error(missing, rttMs, { exitCode: code, signal: err.signal, killed: err.killed });
            return reject(missing);
          }
          const failure: Error & { code?: string | number; killed?: boolean; signal?: string | null } =
            new Error(stderr.trim() || err.message);
          // execFile identifies a silent timeout through these fields, not its message.
          failure.killed = err.killed;
          failure.signal = err.signal;
          if (code !== undefined) failure.code = code;
          opts.trace?.error(failure, rttMs, {
            exitCode: code,
            signal: err.signal,
            killed: err.killed,
            timedOut: Boolean(err.killed && !signal?.aborted),
          });
          return reject(failure);
        }
        try {
          const response = parseCliOutput(stdout);
          opts.trace?.response(response, rttMs);
          resolve(response);
        } catch (e) {
          opts.trace?.error(e, rttMs, { parseError: true });
          reject(e);
        }
      },
    );
    opts.trace?.process(args, opts.cwd, child.pid);
    opts.trace?.stdin(request.user);
    child.stdin?.end(request.user);
  });
}

export function parseCliOutput(stdout: string): ModelResponse {
  const out = JSON.parse(stdout) as {
    result?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  if (out.is_error) throw new Error(out.result || "Claude CLI returned an error");
  const u = out.usage ?? {};
  return {
    text: out.result ?? "",
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: out.total_cost_usd ?? 0,
  };
}

/**
 * Legacy runner kept for the existing panel path. It stays a ModelRunner and
 * reuses the shared spawn runner. The optional third thinking effort applies
 * the resolved profile's effort; the default keeps the historical medium.
 */
export function claudeCliRunner(
  claudePath = "claude",
  cwd?: string,
  thinkingEffort: ThinkingEffort = "medium",
  trace?: LlmTrace,
): ModelRunner {
  return (req: ModelRequest, signal?: AbortSignal) => {
    const profile: ModelProfile = { provider: "claude", model: req.model, thinkingEffort };
    return execClaude({ claudePath, cwd, trace }, req, profile, signal);
  };
}
