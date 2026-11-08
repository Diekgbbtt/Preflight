import * as vscode from "vscode";
import { analyze, claudeCliRunner, review, type Analysis, type Review, type ReviewMode } from "@prompt-preflight/core";
import { sendPrompt } from "./send";
import type { StudyLog } from "./studyLog";
import type { WorkspaceIndex } from "./workspace";

type FromWebview =
  | { type: "ready" }
  | { type: "input"; text: string }
  | { type: "deepReview" }
  | { type: "useImproved" }
  | { type: "send" }
  | { type: "copy" };

/** Per-draft numbers for the study log; reset after each send. */
interface Draft {
  startedAt?: number;
  firstScore?: number;
  quickReviews: number;
  deepReviews: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usedImproved: boolean;
}

const newDraft = (): Draft => ({ quickReviews: 0, deepReviews: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, usedImproved: false });

export class PromptPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "promptPreflight.panel";

  private view?: vscode.WebviewView;
  private text = "";
  private analysis?: Analysis;
  private improved?: string;
  private draft = newDraft();
  private pauseTimer?: NodeJS.Timeout;
  private lastQuickText = "";
  private running: Partial<Record<ReviewMode, AbortController>> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspace: WorkspaceIndex,
    private readonly log: StudyLog,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && void this.workspace.refresh());
  }

  /** Put text into the prompt box, e.g. from an editor selection. */
  setText(text: string): void {
    this.text = text;
    this.post({ type: "setText", text });
    this.onInput(text);
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private cfg() {
    return vscode.workspace.getConfiguration("promptPreflight");
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        if (this.text) this.post({ type: "setText", text: this.text });
        this.onInput(this.text);
        break;
      case "input":
        this.onInput(m.text);
        break;
      case "deepReview":
        await this.runReview("deep");
        break;
      case "useImproved":
        if (this.improved) {
          this.draft.usedImproved = true;
          this.setText(this.improved);
        }
        break;
      case "copy":
        await vscode.env.clipboard.writeText(this.text);
        void vscode.window.showInformationMessage("Prompt copied.");
        break;
      case "send":
        await this.send();
        break;
    }
  }

  // Tier 1: rules on every keystroke. Tier 2: small model when typing pauses.
  private onInput(text: string): void {
    this.text = text;
    if (text.trim() && this.draft.startedAt === undefined) this.draft.startedAt = Date.now();
    this.analysis = analyze(text, this.workspace.context());
    if (this.draft.firstScore === undefined && text.trim().split(/\s+/).length >= 3) {
      this.draft.firstScore = this.analysis.score;
    }
    this.post({ type: "analysis", text, analysis: this.analysis });

    clearTimeout(this.pauseTimer);
    this.running.quick?.abort();
    if (!this.cfg().get<boolean>("quickReviewOnPause", true)) return;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words < 5 || this.analysis.level === "trivial" || text === this.lastQuickText) return;
    this.pauseTimer = setTimeout(() => void this.runReview("quick"), this.cfg().get<number>("pauseMs", 1500));
  }

  // Tier 3: detailed feedback on request.
  private async runReview(mode: ReviewMode): Promise<void> {
    const text = this.text;
    if (!text.trim()) return;
    this.running[mode]?.abort();
    const ctrl = new AbortController();
    this.running[mode] = ctrl;
    if (mode === "quick") this.lastQuickText = text;
    this.post({ type: "reviewing", mode });

    const model = this.cfg().get<string>(mode === "quick" ? "quickModel" : "deepModel", mode === "quick" ? "haiku" : "sonnet");
    const run = claudeCliRunner(this.cfg().get<string>("claudePath", "claude"), this.workspace.root);
    try {
      const r: Review = await review(
        text,
        mode,
        run,
        model,
        { analysis: this.analysis, projectNotes: this.workspace.notes() },
        ctrl.signal,
      );
      this.draft[mode === "quick" ? "quickReviews" : "deepReviews"]++;
      this.draft.inputTokens += r.usage.inputTokens;
      this.draft.outputTokens += r.usage.outputTokens;
      this.draft.costUsd += r.usage.costUsd;
      if (mode === "deep") this.improved = r.improvedPrompt;
      this.post({ type: "review", mode, text, review: r });
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded by newer input
      if (mode === "quick") this.lastQuickText = ""; // allow a retry
      this.post({ type: "review", mode, text, error: (e as Error).message });
    } finally {
      if (this.running[mode] === ctrl) delete this.running[mode];
    }
  }

  // Tier 4: hand the prompt to the coding agent.
  private async send(): Promise<void> {
    const text = this.text.trim();
    if (!text) return;
    const a = analyze(text, this.workspace.context());
    let sentAnyway = false;
    if (a.shouldClarify) {
      const secret = a.findings.some((f) => f.category === "privacy");
      const choice = await vscode.window.showWarningMessage(
        secret
          ? "Your prompt seems to contain a secret. Send anyway?"
          : "Your prompt still has open questions. The agent will have to guess. Send anyway?",
        { modal: true },
        "Send anyway",
      );
      if (choice !== "Send anyway") return;
      sentAnyway = true;
    }
    const target = await sendPrompt(text, this.workspace.root);
    const d = this.draft;
    await this.log.write("send", {
      workspace: vscode.workspace.name,
      target,
      prompt: text,
      promptChars: text.length,
      draftMs: d.startedAt ? Date.now() - d.startedAt : 0,
      firstScore: d.firstScore ?? a.score,
      finalScore: a.score,
      finalLevel: a.level,
      dimensions: a.dimensions,
      rules: a.findings.map((f) => f.rule),
      shouldClarify: a.shouldClarify,
      sentAnyway,
      quickReviews: d.quickReviews,
      deepReviews: d.deepReviews,
      usedImprovedPrompt: d.usedImproved,
      preflightInputTokens: d.inputTokens,
      preflightOutputTokens: d.outputTokens,
      preflightCostUsd: d.costUsd,
    });
    this.draft = newDraft();
    this.improved = undefined;
    this.lastQuickText = "";
    this.setText("");
    this.post({ type: "sent" });
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Prompt Preflight</title>
</head>
<body>
  <div class="score">
    <div class="bar"><div class="fill" id="fill"></div></div>
    <span id="level" class="level">Start typing</span>
  </div>
  <div id="dims" class="dims"></div>
  <div class="editor">
    <div class="backdrop" id="backdrop"><div id="highlights"></div></div>
    <textarea id="prompt" spellcheck="false" placeholder="Describe the task for Claude Code…&#10;&#10;Which files? What should change? How will you know it's done?"></textarea>
  </div>
  <div class="actions">
    <button id="send" title="Cmd/Ctrl+Enter">Send to Claude Code</button>
    <button id="deep" class="secondary">Detailed feedback</button>
    <button id="copy" class="secondary icon" title="Copy prompt">Copy</button>
  </div>
  <section id="questions" hidden><h3>Questions to answer</h3><ul></ul></section>
  <section id="findings" hidden><h3>Notes</h3><ul></ul></section>
  <section id="quick" hidden><h3>Quick check <span class="tag">small model</span></h3><div class="body"></div></section>
  <section id="deepOut" hidden><h3>Detailed feedback</h3><div class="body"></div></section>
  <script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }
}
