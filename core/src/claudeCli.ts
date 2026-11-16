import { execFile } from "node:child_process";
import type { ModelRequest, ModelResponse, ModelRunner } from "./review";
import type { ModelCapabilities, ModelProfile, ModelProvider, ProfileValidation, ThinkingEffort } from "./model";

const DEFAULT_TIMEOUT_MS = 120_000;

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

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === "low" || value === "medium" || value === "high";
}

export function validateClaudeProfile(profile: ModelProfile): ProfileValidation {
  if (profile.provider !== "claude") {
    return { ok: false, message: `Provider "${String(profile.provider)}" is not claude; the Claude adapter only accepts claude profiles.` };
  }
  if (profile.model.trim() === "") return { ok: false, message: "Model must not be empty." };
  if (!isThinkingEffort(profile.thinkingEffort)) {
    return { ok: false, message: `Thinking effort "${String(profile.thinkingEffort)}" is not one of low, medium, high.` };
  }
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

export function createClaudeProvider(profile: ModelProfile, config: { claudePath: string }): ModelProvider {
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
    complete: (request, signal) => execClaude({ claudePath: config.claudePath }, request, profile, signal),
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
  opts: { claudePath: string; cwd?: string },
  request: ModelRequest,
  profile: ModelProfile,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  if (request.model !== profile.model) {
    return Promise.reject(
      new Error(`Model mismatch: request model "${request.model}" does not match the profile model "${profile.model}".`),
    );
  }
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise<ModelResponse>((resolve, reject) => {
    const child = execFile(
      opts.claudePath,
      buildClaudeArgs(request, profile),
      { cwd: opts.cwd, signal, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (signal?.aborted || err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
            return reject(cancelledError());
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            return reject(
              new Error(`Claude Code CLI not found at "${opts.claudePath}". Install it or set promptPreflight.claudePath.`),
            );
          }
          const failure: Error & { code?: string | number } = new Error(stderr.trim() || err.message);
          if (code !== undefined) failure.code = code;
          return reject(failure);
        }
        try {
          resolve(parseCliOutput(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
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
 * gains --effort medium once the shared spawn runner lands.
 */
export function claudeCliRunner(claudePath = "claude", cwd?: string): ModelRunner {
  return (req: ModelRequest, signal?: AbortSignal) =>
    new Promise<ModelResponse>((resolve, reject) => {
      const args = [
        "-p",
        "--model", req.model,
        "--output-format", "json",
        "--tools", "",
        "--setting-sources", "",
        "--system-prompt", req.system,
      ];
      const child = execFile(
        claudePath,
        args,
        { cwd, signal, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const hint = (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `Claude Code CLI not found at "${claudePath}". Install it or set promptPreflight.claudePath.`
              : stderr.trim() || err.message;
            return reject(new Error(hint));
          }
          try {
            resolve(parseCliOutput(stdout));
          } catch (e) {
            reject(e);
          }
        },
      );
      // Prompt goes over stdin so it can't be mistaken for a flag and has no length limit.
      child.stdin?.end(req.user);
    });
}
