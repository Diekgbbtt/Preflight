import { execFile } from "node:child_process";
import type { ModelRequest, ModelResponse, ModelRunner } from "./review";

/**
 * Runs a model call through the Claude Code CLI (`claude -p`), using the user's own Claude login.
 * No tools, no project settings or hooks, so the call is small and can't touch files.
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
        { cwd, signal, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
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
