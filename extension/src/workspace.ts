import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { WorkspaceContext } from "@prompt-preflight/core";

const EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,.next,target}/**";

/** Knows the project's files and recent git changes, so checks can be project-aware. */
export class WorkspaceIndex implements vscode.Disposable {
  private files: string[] = [];
  private recent: string[] = [];
  private disposables: vscode.Disposable[] = [];
  private refreshTimer?: NodeJS.Timeout;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
    this.disposables.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()));
    void this.refresh();
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 2000);
  }

  async refresh(): Promise<void> {
    if (!this.root) {
      this.files = [];
      this.recent = [];
      return;
    }
    const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, 20000);
    this.files = uris.map((u) => vscode.workspace.asRelativePath(u, false).toLowerCase());
    this.recent = await gitRecentFiles(this.root);
  }

  context(): WorkspaceContext {
    if (!this.root || this.files.length === 0) return { recentFiles: this.recent };
    return { fileExists: (ref) => this.exists(ref), recentFiles: this.recent };
  }

  exists(ref: string): boolean {
    let r = ref.toLowerCase().replace(/^\.\//, "");
    // "/api/users" is more likely a URL route than a file.
    if (r.startsWith("/") && !/\.\w+$/.test(r)) return true;
    r = r.replace(/^\/+/, "").replace(/^(\.\.\/)+/, "");
    const isDir = r.endsWith("/") || !/\.\w+$/.test(r);
    r = r.replace(/\/$/, "");
    return this.files.some(
      (f) =>
        f === r ||
        f.endsWith("/" + r) ||
        (isDir && (f.startsWith(r + "/") || f.includes("/" + r + "/"))),
    );
  }

  /** Short project facts for the model review. */
  notes(): string {
    const top = [...new Set(this.files.map((f) => f.split("/")[0]))].slice(0, 30);
    const lines = [`Top-level entries: ${top.join(", ") || "none"}`];
    if (this.recent.length) lines.push(`Recently changed files: ${this.recent.join(", ")}`);
    return lines.join("\n");
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)),
  );
}

/** Uncommitted changes first, then files from the last few commits. */
async function gitRecentFiles(cwd: string): Promise<string[]> {
  const status = (await git(cwd, ["status", "--porcelain"]))
    .split("\n")
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .map((l) => l.split(" -> ").pop()!)
    .filter(Boolean);
  const log = (await git(cwd, ["log", "-n", "5", "--name-only", "--pretty=format:"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return [...new Set([...status, ...log])].slice(0, 8);
}
