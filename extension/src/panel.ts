import * as vscode from "vscode";
import {
  addedRanges,
  analyze,
  claudeCliRunner,
  mergeAnswers,
  review,
  type Analysis,
  type Answer,
  type Review,
  type ReviewMode,
} from "@prompt-preflight/core";
import { sendPrompt } from "./send";
import type { StudyLog } from "./studyLog";
import type { WorkspaceIndex } from "./workspace";

type FromWebview =
  | { type: "ready" }
  | { type: "input"; text: string }
  | { type: "deepReview" }
  | { type: "cancel" }
  | { type: "merge"; answers: Answer[] }
  | { type: "send" };

/** Per-draft numbers for the study log; reset after each send. */
interface Draft {
  startedAt?: number;
  firstScore?: number;
  quickReviews: number;
  deepReviews: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  mergedAnswers: boolean;
}

const newDraft = (): Draft => ({ quickReviews: 0, deepReviews: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, mergedAnswers: false });

export class PromptPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "promptPreflight.panel";

  private view?: vscode.WebviewView;
  private text = "";
  private analysis?: Analysis;
  /** The prompt before the first merge in this draft; text added since is shown as the user's. */
  private base?: string;
  private draft = newDraft();
  private pauseTimer?: NodeJS.Timeout;
  private lastQuickText = "";
  private running: Partial<Record<ReviewMode | "merge", AbortController>> = {};

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
    const cfgWatch = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("promptPreflight.sendTo") || e.affectsConfiguration("promptPreflight.pauseMs")) this.postConfig();
    });
    view.onDidDispose(() => cfgWatch.dispose());
  }

  /** Put text into the prompt box, e.g. from an editor selection. */
  setText(text: string): void {
    this.text = text;
    this.base = undefined;
    this.post({ type: "setText", text });
    this.onInput(text);
  }

  async copy(): Promise<void> {
    await vscode.env.clipboard.writeText(this.text);
    void vscode.window.showInformationMessage("Prompt copied.");
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private postConfig(): void {
    const toClipboard = this.cfg().get<string>("sendTo", "terminal") === "clipboard";
    this.post({
      type: "config",
      sendLabel: toClipboard ? "Copy for Claude Code" : "Send to Claude Code",
      pauseMs: this.cfg().get<number>("pauseMs", 1500),
    });
  }

  private cfg() {
    return vscode.workspace.getConfiguration("promptPreflight");
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        this.postConfig();
        if (this.text) this.post({ type: "setText", text: this.text });
        this.onInput(this.text);
        break;
      case "input":
        this.onInput(m.text);
        break;
      case "deepReview":
        await this.runReview("deep");
        break;
      case "cancel":
        this.running.deep?.abort();
        this.post({ type: "cancelled", mode: "deep" });
        break;
      case "merge":
        await this.merge(m.answers);
        break;
      case "send":
        await this.send();
        break;
    }
  }

  private model(mode: ReviewMode): string {
    return this.cfg().get<string>(mode === "quick" ? "quickModel" : "deepModel", mode === "quick" ? "haiku" : "sonnet");
  }

  private runner() {
    return claudeCliRunner(this.cfg().get<string>("claudePath", "claude"), this.workspace.root);
  }

  private count(usage: Review["usage"]): void {
    this.draft.inputTokens += usage.inputTokens;
    this.draft.outputTokens += usage.outputTokens;
    this.draft.costUsd += usage.costUsd;
  }

  // Tier 1: rules on every keystroke. Tier 2: small model when typing pauses.
  private onInput(text: string): void {
    this.text = text;
    if (!text.trim()) this.base = undefined;
    if (text.trim() && this.draft.startedAt === undefined) this.draft.startedAt = Date.now();
    this.analysis = analyze(text, this.workspace.context());
    if (this.draft.firstScore === undefined && text.trim().split(/\s+/).length >= 3) {
      this.draft.firstScore = this.analysis.score;
    }
    const added = this.base === undefined ? [] : addedRanges(this.base, text);
    this.post({ type: "analysis", text, analysis: this.analysis, added });

    clearTimeout(this.pauseTimer);
    this.running.quick?.abort();
    if (!this.cfg().get<boolean>("quickReviewOnPause", true)) return;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words < 5 || this.analysis.level === "trivial" || text === this.lastQuickText) return;
    this.pauseTimer = setTimeout(() => void this.runReview("quick"), this.cfg().get<number>("pauseMs", 1500));
  }

  // Tier 3: clarifying questions on request.
  private async runReview(mode: ReviewMode): Promise<void> {
    const text = this.text;
    if (!text.trim()) return;
    this.running[mode]?.abort();
    const ctrl = new AbortController();
    this.running[mode] = ctrl;
    if (mode === "quick") this.lastQuickText = text;
    this.post({ type: "reviewing", mode });

    try {
      const r: Review = await review(
        text,
        mode,
        this.runner(),
        this.model(mode),
        { analysis: this.analysis, projectNotes: this.workspace.notes() },
        ctrl.signal,
      );
      this.draft[mode === "quick" ? "quickReviews" : "deepReviews"]++;
      this.count(r.usage);
      this.post({ type: "review", mode, text, review: r });
    } catch (e) {
      if (ctrl.signal.aborted) return; // superseded by newer input or cancelled
      if (mode === "quick") this.lastQuickText = ""; // allow a retry
      this.post({ type: "review", mode, text, error: (e as Error).message });
    } finally {
      if (this.running[mode] === ctrl) delete this.running[mode];
    }
  }

  // The user's answers, written into the prompt. Only on their request; the webview applies it undoably.
  private async merge(answers: Answer[]): Promise<void> {
    const text = this.text;
    const filled = answers.filter((a) => a.answer.trim());
    if (!text.trim() || filled.length === 0) return;
    this.running.merge?.abort();
    const ctrl = new AbortController();
    this.running.merge = ctrl;
    try {
      const r = await mergeAnswers(text, filled, this.runner(), this.model("quick"), ctrl.signal);
      this.count(r.usage);
      if (this.text !== text) throw new Error("The prompt changed while adding your answers. Try again.");
      this.base ??= text;
      this.draft.mergedAnswers = true;
      this.post({ type: "merged", text: r.text });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      this.post({ type: "mergeError", error: (e as Error).message });
    } finally {
      if (this.running.merge === ctrl) delete this.running.merge;
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
      mergedAnswers: d.mergedAnswers,
      preflightInputTokens: d.inputTokens,
      preflightOutputTokens: d.outputTokens,
      preflightCostUsd: d.costUsd,
    });
    this.draft = newDraft();
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Prompt Preflight</title>
</head>
<body>
  <main class="card">
    <div class="editor">
      <div class="backdrop" aria-hidden="true"><div id="highlights"></div></div>
      <textarea id="prompt" aria-label="Prompt for Claude Code" spellcheck="false" placeholder="What should Claude Code do?&#10;Which files, what change, and how you'll know it's done."></textarea>
    </div>
    <div id="pillsWrap" class="collapse" inert><div id="pills" class="pills"></div></div>
    <div id="qWrap" class="collapse" inert><section id="questions" class="questions" aria-label="Questions about your prompt"></section></div>
    <div class="footer">
      <div class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <span id="level" class="level" aria-live="polite"></span>
      <button id="ask" class="pill tool ask" tabindex="-1" aria-hidden="true">Ask me</button>
      <button id="send" class="send" aria-label="Send to Claude Code" disabled>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <p id="status" class="status" role="status"></p>
  </main>
  <script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }
}
