import * as vscode from "vscode";

/** Quote a string for POSIX shells: 'it'\''s'. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Hands the prompt to Claude Code. Each send starts a fresh interactive session,
 * which matches the one-shot setup of the user study.
 */
export async function sendPrompt(text: string, cwd: string | undefined, target: "terminal" | "clipboard", sessionId?: string, onClosed?: () => void): Promise<"terminal" | "clipboard"> {
  const cfg = vscode.workspace.getConfiguration("promptPreflight");
  if (target === "clipboard") {
    await vscode.env.clipboard.writeText(text);
    return "clipboard";
  }
  const claude = cfg.get<string>("claudePath", "claude");
  const terminal = vscode.window.createTerminal({
    name: "Claude Code (Preflight)", cwd, shellPath: claude,
    shellArgs: [...(sessionId ? ["--session-id", sessionId] : []), "--", text],
    env: sessionId ? { PREFLIGHT_AGENT_SESSION_ID: sessionId } : undefined,
  });
  if (onClosed) {
    const subscription = vscode.window.onDidCloseTerminal(closed => {
      if (closed === terminal) { subscription.dispose(); onClosed(); }
    });
  }
  terminal.show();
  return "terminal";
}
