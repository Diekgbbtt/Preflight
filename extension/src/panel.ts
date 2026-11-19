import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  ACTION_LABELS,
  analyzeRules,
  buildReviewRequest,
  FeedbackService,
  QUICK_PROMPT_VERSION,
  parseDeepReview,
  improvePrompt,
  type DeepReview,
  hashPrompt,
  isFreshScore,
  GatePolicy,
  presentFeedback,
  type ScoreReport,
  type QuickReview,
  type SendRecord,
  type RuleReport,
  claudeCliRunner,
  createProvider,
  extractJson,
  feedbackLogMessage,
  feedbackMessage,
  isRetryable,
  mapError,
  resolveProfile,
  type FeedbackError,
  type ReviewMode,
} from "@prompt-preflight/core";
import * as path from "node:path";
import { JsonlRepository } from "./repository";
import { AgentUsageRecovery } from "./agentUsageRecovery";
import type { StudyLinks } from "./studyEvents";
import { readModelConfig } from "./modelSettings";
import { sendPrompt } from "./send";
import type { StudyLog } from "./studyLog";
import type { WorkspaceIndex } from "./workspace";

type FromWebview =
  | { type: "ready" }
  | { type: "input"; text: string }
  | { type: "deepReview" }
  | { type: "enhance" }
  | { type: "useImproved" }
  | { type: "improve" }
  | { type: "send" }
  | { type: "copy" };

/** Per-draft numbers for the study log; reset after each send. */
interface Draft {
  id: string;
  sendId: string;
  startedAt?: number;
  firstScore?: number;
  quickReviews: number;
  deepReviews: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usedImproved: boolean;
}

const newDraft = (): Draft => ({ id: randomUUID(), sendId: randomUUID(), quickReviews: 0, deepReviews: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, usedImproved: false });

export class PromptPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "promptPreflight.panel";

  private view?: vscode.WebviewView;
  private text = "";
  private analysis?: RuleReport;
  private score: ScoreReport | null = null;
  private quick?: QuickReview;
  private quickText = "";
  private sending = false;
  private enhancing = false;
  private revision = 0;
  private quickPending?: { text: string; promise: Promise<ScoreReport | null> };
  private readonly feedback = new FeedbackService({ now: Date.now });
  private readonly sends: JsonlRepository<SendRecord>;
  private readonly usageRecovery: AgentUsageRecovery;
  private improved?: string;
  private deep?: { text: string; review: DeepReview };
  private draft = newDraft();
  private pauseTimer?: NodeJS.Timeout;
  private running: Partial<Record<ReviewMode, AbortController>> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspace: WorkspaceIndex,
    private readonly log: StudyLog,
    storage: vscode.Uri,
    homeDir?: string,
    usageRecovery?: AgentUsageRecovery,
  ) {
    this.sends = new JsonlRepository(path.join(storage.fsPath, "sends.jsonl"));
    this.usageRecovery = usageRecovery ?? new AgentUsageRecovery({ storagePath: storage.fsPath, log, homeDir });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && void this.workspace.refresh());
    const settings = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (event.affectsConfiguration("promptPreflight.sendTo")) this.postSendTarget();
    });
    view.onDidDispose?.(() => settings?.dispose());
  }

  /** Put text into the prompt box, e.g. from an editor selection. */
  setText(text: string): void {
    // The textarea exposes LF even when editor selections use CRLF.
    text = text.replace(/\r\n?/g, "\n");
    this.post({ type: "setText", text });
    this.onInput(text);
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private cfg() {
    return vscode.workspace.getConfiguration("promptPreflight");
  }

  private sendTarget(): SendRecord["target"] {
    return this.cfg().get<string>("sendTo", "terminal") === "clipboard" ? "clipboard" : "terminal";
  }

  private postSendTarget(): void {
    this.post({ type: "sendTarget", target: this.sendTarget() });
  }

  private async onMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.type !== "string" || !["ready", "input", "enhance", "deepReview", "useImproved", "improve", "send", "copy"].includes(candidate.type)) return;
    if (candidate.type === "input" && typeof candidate.text !== "string") return;
    const m = candidate as FromWebview;
    switch (m.type) {
      case "ready":
        this.postSendTarget();
        if (this.text) this.post({ type: "setText", text: this.text });
        this.onInput(this.text);
        break;
      case "input":
        this.onInput(m.text);
        break;
      case "enhance":
        await this.enhance();
        break;
      case "deepReview":
        await this.runReview("deep");
        break;
      case "improve":
        await this.runImprove();
        break;
      case "useImproved":
        if (this.improved) {
          this.draft.usedImproved = true;
          this.setText(this.improved);
        }
        break;
      case "copy":
        if (this.text.trim()) {
          try {
            await vscode.env.clipboard.writeText(this.text);
            this.post({ type: "copied" });
          } catch { void vscode.window.showErrorMessage("Could not copy the prompt. Try again."); }
        }
        break;
      case "send":
        await this.send();
        break;
    }
  }

  // Local rules run on every input. Models run only for an explicit enhancement.
  private onInput(text: string): void {
    if (this.text !== text) this.revision++;
    this.text = text;
    this.improved = undefined;
    if (this.running.deep && !this.running.deep.signal.aborted) {
      this.running.deep.abort();
      this.post({ type: "reviewCancelled", mode: "deep" });
    }
    if (text.trim() && this.draft.startedAt === undefined) this.draft.startedAt = Date.now();
    this.analysis = analyzeRules(text, this.workspace.context());
    if (!isFreshScore(this.score, text)) this.post({ type: "score", text, state: this.score ? "stale" : "idle", score: null });
    else this.post({ type: "score", text, state: "scored", score: this.score });
    // Keep highlights instant; visible advice waits for a pause.
    this.post({ type: "analysis", text, analysis: this.analysis, feedback: null });

    clearTimeout(this.pauseTimer);
    const abortedQuick = this.running.quick;
    if (abortedQuick && !abortedQuick.signal.aborted) {
      abortedQuick.abort();
      this.post({ type: "reviewCancelled", mode: "quick" });
    }
    if (abortedQuick && this.running.quick === abortedQuick) delete this.running.quick;
    // Local notes settle after a short pause; typing never schedules inference.
    this.pauseTimer = setTimeout(() => this.postFeedback(), Math.max(100, this.cfg().get<number>("feedbackPauseMs", 300)));
  }

  private postFeedback(): void {
    if (!this.analysis) return;
    const current = this.quickText === this.text ? this.quick : undefined;
    this.post({ type: "analysis", text: this.text, analysis: this.analysis, feedback: presentFeedback(this.analysis, current) });
  }

  private links(draft = this.draft): StudyLinks { return { draftId: draft.id, sendId: draft.sendId, sessionId: null }; }

  private async record(event: "send" | "score" | "review" | "agent-usage", links: StudyLinks, data: Record<string, unknown>): Promise<void> {
    try { await this.log.write(event, links, data); }
    catch { console.error("Preflight study log write failed"); }
  }

  private async enhance(): Promise<void> {
    if (this.enhancing || this.running.deep || this.sending || !this.text.trim()) return;
    const revision = this.revision;
    this.enhancing = true;
    this.improved = undefined;
    try {
      await this.runReview("deep");
      if (revision === this.revision && !this.sending) await this.runImprove();
    } finally { this.enhancing = false; }
  }

  private runReview(mode: ReviewMode, attempt = 0, signal?: AbortSignal): Promise<ScoreReport | null> {
    if (mode !== "quick") return this.performReview(mode, attempt, signal);
    if (this.quickPending?.text === this.text && !this.running.quick?.signal.aborted) {
      const active = this.running.quick;
      const abort = () => active?.abort();
      const promise = this.quickPending.promise;
      signal?.addEventListener("abort", abort, { once: true });
      return promise.finally(() => signal?.removeEventListener("abort", abort));
    }
    const text = this.text;
    const promise = this.performReview(mode, attempt, signal);
    this.quickPending = { text, promise };
    void promise.finally(() => { if (this.quickPending?.promise === promise) this.quickPending = undefined; });
    return promise;
  }

  // Execution reports provider failures on the explicit review path.
  private async performReview(mode: ReviewMode, attempt = 0, signal?: AbortSignal): Promise<ScoreReport | null> {
    const text = this.text;
    const draft = this.draft;
    if (!text.trim() || signal?.aborted) return null;
    this.running[mode]?.abort();
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.running[mode] = ctrl;
    const started = Date.now();
    if (mode === "deep") this.deep = undefined;
    this.post({ type: "reviewing", mode, text });
    if (mode === "quick") this.post({ type: "score", text, state: "scoring", score: null });
    try {
      const config = readModelConfig();
      const profile = resolveProfile(config, mode);
      const provider = createProvider(profile, config);
      const validation = provider.validateProfile(profile);
      if (!validation.ok) throw new Error(validation.message);
      const run = claudeCliRunner(config.claudePath, this.workspace.root, profile.thinkingEffort);
      const context = { analysis: this.analysis, projectNotes: this.workspace.notes() };
      const quick = mode === "quick" ? await this.feedback.quick(text, run, profile, context, ctrl.signal) : null;
      const response = quick ? null : await run(buildReviewRequest(text, mode, profile.model, context), ctrl.signal);
      if (ctrl.signal.aborted || text !== this.text || draft !== this.draft) return null;
      if (response) {
        const payload = extractJson(response.text) as Partial<DeepReview> | null;
        if (!payload || !Array.isArray(payload.issues) || !Array.isArray(payload.questions)) {
          throw new SyntaxError("Invalid review JSON");
        }
      }
      const usage = quick?.usage ?? { inputTokens: response!.inputTokens, outputTokens: response!.outputTokens, costUsd: response!.costUsd };
      const latencyMs = Date.now() - started;
      draft[mode === "quick" ? "quickReviews" : "deepReviews"]++;
      draft.inputTokens += usage.inputTokens;
      draft.outputTokens += usage.outputTokens;
      draft.costUsd += usage.costUsd;
      const reviewId = randomUUID();
      const links = { ...this.links(draft), reviewId };
      const metadata = { ...profile, latencyMs, contextManifestHash: null, tokens: usage, cost: usage.costUsd, promptHash: hashPrompt(text) };
      if (mode === "quick") {
        this.quick = quick!;
        this.quickText = text;
        this.score = this.quick.score;
        if (draft.firstScore === undefined && this.score) draft.firstScore = this.score.score;
        this.post({ type: "score", text, state: this.score ? "scored" : "error", score: this.score });
        this.postFeedback();
        const feedback = presentFeedback(this.analysis!, this.quick);
        this.post({ type: "review", mode, text, review: { issues: feedback.issues, questions: [], usage } });
        await this.record("score", links, { ...metadata, scoreSource: "quick", promptVersion: QUICK_PROMPT_VERSION, scoreAvailable: !!quick!.score, score: quick!.score });
      } else {
        const deep = parseDeepReview(response!.text, text, { usage, latency: latencyMs });
        this.deep = { text, review: deep };
        this.post({ type: "review", mode, text, review: { ...deep, questions: deep.questions.map(q => q.question) } });
      }
      await this.record("review", links, { ...metadata, mode, issueCount: quick?.issues.length });
      return quick?.score ?? null;
    } catch (e) {
      if (ctrl.signal.aborted || text !== this.text || draft !== this.draft) return null;
      const error = mapError(e);
      if (isRetryable(error) && attempt === 0 && !signal) return this.performReview(mode, 1);
      this.reportError(mode, text, error);
      return null;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.running[mode] === ctrl) {
        delete this.running[mode];
        if (ctrl.signal.aborted) {
          this.post({ type: "reviewCancelled", mode });
          if (mode === "quick" && text === this.text) this.post({ type: "score", text, state: "idle", score: null });
        }
      }
    }
  }

  private async runImprove(): Promise<void> {
    const deep = this.deep;
    if (!deep || deep.text !== this.text || !deep.review.questions.length || this.running.deep || this.sending) return;
    const draft = this.draft;
    const ctrl = new AbortController();
    this.running.deep = ctrl;
    this.post({ type: "rewriting", text: deep.text });
    try {
      const config = readModelConfig();
      const profile = resolveProfile(config, "deep");
      const run = claudeCliRunner(config.claudePath, this.workspace.root, profile.thinkingEffort);
      const improved = await improvePrompt(deep.text, deep.review, [], run, profile.model, { now: Date.now }, ctrl.signal);
      if (ctrl.signal.aborted || deep.text !== this.text || draft !== this.draft) return;
      if (!improved) throw new SyntaxError("Invalid rewrite JSON");
      this.improved = improved.text;
      draft.inputTokens += improved.usage.inputTokens; draft.outputTokens += improved.usage.outputTokens; draft.costUsd += improved.usage.costUsd;
      this.post({ type: "improved", text: deep.text, improved: improved.text });
      await this.record("review", { ...this.links(draft), reviewId: randomUUID() }, { ...profile, mode: "improve", latencyMs: improved.latency, tokens: improved.usage, cost: improved.usage.costUsd, promptVersion: improved.promptVersion, promptHash: hashPrompt(deep.text) });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const error = mapError(e);
        this.post({ type: "rewriteError", text: deep.text, error: feedbackMessage(error).message });
      }
    }
    finally { if (this.running.deep === ctrl) delete this.running.deep; }
  }

  /**
   * Degraded reporting: post the fixed message and error code to the webview
   * (which clears the loading state), keep the rule analysis, and surface one
   * action. No improved prompt and no review stats on failure.
   */
  private reportError(mode: ReviewMode, text: string, error: FeedbackError): void {
    if (mode === "quick") this.post({ type: "score", text, state: "error", score: null });
    this.post({
      type: "review",
      mode,
      text,
      error: feedbackMessage(error).message,
    });
    showFeedbackError(error, () => void (mode === "deep" ? this.enhance() : this.runReview(mode)));
  }

  private async send(): Promise<void> {
    if (this.sending || !this.text.trim()) return;
    this.sending = true;
    this.post({ type: "sending", busy: true });
    const text = this.text;
    const draft = this.draft;
    const revision = this.revision;
    const rules = analyzeRules(text, this.workspace.context());
    try {
      const score = isFreshScore(this.score, text) ? this.score : null;
      const decision = GatePolicy.decide(rules, score, {
        gateSending: this.cfg().get<boolean>("gateSending", false),
        threshold: this.cfg().get<number>("scoreThreshold", 65),
        scoreRequired: false,
      });
      const target = this.sendTarget();
      if (decision.action === "confirm") {
        const choice = await vscode.window.showWarningMessage(decision.reasons.join(" ") + " Send anyway?", { modal: true }, "Send anyway");
        if (choice !== "Send anyway" || this.revision !== revision) return;
      }
      const sessionId = target === "terminal" ? randomUUID() : null;
      const links = { ...this.links(draft), sessionId };
      const sentAt = Date.now();
      const cwd = this.workspace.root;
      let tracking = false;
      if (sessionId && cwd && this.log.enabled) {
        try { tracking = await this.usageRecovery.track(links, vscode.Uri.file(cwd).toString()); }
        catch { console.error("Preflight could not persist pending agent usage"); }
      }
      if (this.revision !== revision || this.sendTarget() !== target) {
        if (tracking) await this.usageRecovery.cancel(links.sendId).catch(() => {});
        return;
      }
      await sendPrompt(text, cwd, target, sessionId ?? undefined,
          tracking ? () => { void this.captureAgentUsage(links, cwd); } : undefined).catch(async error => {
        if (tracking) await this.usageRecovery.cancel(links.sendId).catch(() => {});
        throw error;
      });
      this.running.quick?.abort(); this.running.deep?.abort();
      this.draft = newDraft();
      this.score = null; this.quick = undefined; this.quickText = ""; this.improved = undefined; this.deep = undefined;
      if (this.revision === revision) this.setText("");
      else if (this.text.trim()) this.draft.startedAt = Date.now();
      this.post({ type: "sent", target });
      if (this.text.trim()) this.postFeedback();
      try { await this.sends.append({ id: draft.sendId, ts: new Date(sentAt).toISOString(), draftId: draft.id,
        folderUri: cwd ? vscode.Uri.file(cwd).toString() : "", text,
        promptHash: hashPrompt(text), sessionId: sessionId ?? undefined, target }); }
      catch { void vscode.window.showWarningMessage("Prompt sent, but its local send record could not be saved."); }
      await this.record("send", links, {
        target, promptHash: hashPrompt(text), promptChars: text.length, draftMs: draft.startedAt ? sentAt - draft.startedAt : 0,
        firstScore: draft.firstScore ?? null, finalScore: score?.score ?? null,
        scoreAvailable: !!score, score: score?.score ?? null, scoreSource: score ? "quick" : null,
        scoreProvider: score?.provider ?? null, scoreModel: score?.model ?? null, scoreThinkingEffort: score?.thinkingEffort ?? null,
        rubricVersion: score?.rubricVersion ?? null, scoreAgeMs: score ? Math.max(0, sentAt - Date.parse(score.scoredAt)) : null,
        sentAnyway: decision.action === "confirm", usedImprovedPrompt: draft.usedImproved, quickReviews: draft.quickReviews, deepReviews: draft.deepReviews,
        preflightInputTokens: draft.inputTokens, preflightOutputTokens: draft.outputTokens, preflightCostUsd: draft.costUsd,
        agentInputTokens: null, agentOutputTokens: null, agentCacheReadTokens: null, agentCacheCreationTokens: null, agentCostUsd: null,
      });
    } catch { void vscode.window.showErrorMessage("Could not send the prompt. Try again."); }
    finally {
      this.sending = false;
      this.post({ type: "sending", busy: false });
    }
  }

  private async captureAgentUsage(links: StudyLinks, cwd = this.workspace.root): Promise<void> {
    if (!cwd || !links.sessionId) return;
    try {
      await this.usageRecovery.track(links, vscode.Uri.file(cwd).toString());
      await this.usageRecovery.closeSession(links.sessionId);
    } catch { console.error("Preflight agent usage remains pending for recovery"); }
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
  <div class="score" title="Local rule checks">
    <div class="bar"><div class="fill" id="fill"></div></div>
    <span id="level" class="level">Local checks · Start typing</span>
  </div>
  <div id="dims" class="dims"></div>
  <div class="editor">
    <div class="backdrop" id="backdrop"><div id="highlights"></div></div>
    <textarea id="prompt" aria-label="Prompt" spellcheck="false" placeholder="Describe the task for Claude Code…&#10;&#10;Which files? What should change? How will you know it's done?"></textarea>
  </div>
  <p id="actionStatus" class="action-status" role="status" hidden></p>
  <div class="actions">
    <button id="send" title="Cmd/Ctrl+Enter">Send to Claude Code</button>
    <button id="deep" class="secondary" title="Use the model to review and improve this draft">Enhance</button>
    <button id="copy" class="secondary icon" title="Copy and keep the draft">Copy</button>
  </div>
  <section id="questions" hidden><h3>Questions to answer</h3><ul></ul></section>
  <section id="findings" hidden><h3>Notes</h3><ul></ul></section>
  <section id="quick" hidden><h3>Quick check <span class="tag">small model</span></h3><div class="body"></div></section>
  <section id="deepOut" hidden><h3>Enhancement</h3><div class="body"></div></section>
  <script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }
}

/**
 * User-facing feedback error surfacing (#42): one fixed message, one action,
 * no stack trace. Logs only the correlation id and the error code; never the
 * message, cause, prompt, or stderr.
 */
export function showFeedbackError(error: FeedbackError, retry?: () => void): void {
  console.error(feedbackLogMessage(error, randomUUID()));
  const label = ACTION_LABELS[error.action];
  void vscode.window.showWarningMessage(feedbackMessage(error).message, label).then((choice) => {
    if (choice !== label) return;
    switch (error.action) {
      case "open-settings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "promptPreflight");
        break;
      case "install-cli":
        void vscode.env.openExternal(vscode.Uri.parse("https://code.claude.com/docs/en/overview"));
        break;
      case "fix-permissions":
        void vscode.commands.executeCommand("workbench.action.openSettings", "promptPreflight.claudePath");
        break;
      case "reduce-context":
        void vscode.commands.executeCommand("workbench.action.openSettings", "promptPreflight.context.includeCode");
        break;
      case "retry":
        retry?.();
        break;
      case "dismiss":
        break;
    }
  });
}
