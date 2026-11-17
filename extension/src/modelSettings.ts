import * as vscode from "vscode";
import type { Config } from "@prompt-preflight/core";

/**
 * Reads the six model settings into a plain Config object for core.
 * Shared by extension.ts and panel.ts so the settings read lives in one place.
 */
export function readModelConfig(): Config {
  const c = vscode.workspace.getConfiguration("promptPreflight");
  return {
    provider: c.get<"claude" | "codex">("provider", "claude"),
    model: c.get("model", "sonnet"),
    thinkingEffort: c.get<string>("thinkingEffort", "medium"),
    quickModel: c.get("quickModel", "haiku"),
    deepModel: c.get("deepModel", "sonnet"),
    claudePath: c.get("claudePath", "claude"),
  };
}
