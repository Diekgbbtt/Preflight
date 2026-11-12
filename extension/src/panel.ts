import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
  addedRanges,
  analyze,
  claudeCliRunner,
  combineGaps,
  mergeAnswers,
  markGap,
  newSession,
  planReview,
  recordRevision,
  review,
  reviewedGaps,
  ruleGaps,
  sessionChange,
  sessionSummary,
  textHash,
  type PromptSession,
  type Reviewed,
  type SessionEnd,
  type Analysis,
  type Gap,
  type Review,
  type ReviewMode,
} from "@prompt-preflight/core";
import { sendPrompt } from "./send";
import { gapCounts, type StudyLog } from "./studyLog";
import type { WorkspaceIndex } from "./workspace";

type FromWebview =
  | { type: "ready" }
  | { type: "input"; text: string }
  | { type: "deepReview" }
  | { type: "cancel" }
  | { type: "dismiss"; id: string }
  | { type: "answer"; answers: { id: string; text: string }[] }
  | { type: "copy"; text: string }
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
  /** Gaps the user answered or dismissed in this draft, by id. */
  answered: Map<string, Gap>;
  dismissed: Map<string, Gap>;
}

const newDraft = (): Draft => ({
  quickReviews: 0,
  deepReviews: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  mergedAnswers: false,
  answered: new Map(),
  dismissed: new Map(),
});

export interface Meter {
  segments: number;
  label: string;
  tone: "blocked" | "weak" | "strong";
}

/** Strength from open gaps: blocking empties it, each open important gap costs a segment, advisory gaps never count. */
export function meterFor(gaps: Gap[]): Meter {
  const open = gaps.filter((g) => g.status === "open");
  if (open.some((g) => g.priority === "blocking")) return { segments: 0, label: "Fix before sending", tone: "blocked" };
  const important = open.filter((g) => g.priority === "important").length;
  if (important === 0) return { segments: 4, label: "Strong prompt", tone: "strong" };
  if (important === 1) return { segments: 3, label: "Almost there", tone: "weak" };
  if (important === 2) return { segments: 2, label: "Getting there", tone: "weak" };
  return { segments: 1, label: "Weak prompt", tone: "weak" };
}

/** Dismissals hold for this id on these exact words, so an edited span asks again. */
const dismissKey = (g: Gap) => `${g.id}\u0000${g.span?.text ?? ""}`;

export class PromptPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "promptPreflight.panel";

  private view?: vscode.WebviewView;
  private text = "";
  private analysis?: Analysis;
  /** Increments on every change to the prompt text, merges included. Model results for older revisions are discarded. */
  private revision = 0;
  private rules: Gap[] = [];
  /** The last review per model and the text it was made for; shown on later text while edits stay small. */
  private reviewed: Partial<Record<ReviewMode, Reviewed>> = {};
  /** The prompt being worked on, from first keystroke to send, copy, clear or replace. */
  private session?: PromptSession;
  /** Text a merge is about to produce, so its revision is recorded as "merge". */
  private pendingMerge?: string;
  /** Dismissed gaps (id + span text) for the current session. */
  private dismissed = new Set<string>();
  /** The prompt before the first merge in this draft; text added since is shown as the user's. */
  private base?: string;
  private draft = newDraft();
  private pauseTimer?: NodeJS.Timeout;
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
    this.base = undefined;
    this.post({ type: "setText", text });
    this.onInput(text);
  }

  /** Copy the prompt and end the session. From the title bar (with a notification) or the panel's own button. */
  async copy(text = this.text, fromPanel = false): Promise<void> {
    if (!text.trim()) return;
    await vscode.env.clipboard.writeText(text);
    this.endSession("copy");
    this.post({ type: "copied" });
    if (!fromPanel) void vscode.window.showInformationMessage("Prompt copied.");
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
        break;
      case "dismiss":
        this.dismiss(m.id);
        break;
      case "answer":
        await this.merge(m.answers);
        break;
      case "copy":
        await this.copy(m.text, true);
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

  /** All gaps for the current revision, with session dismissals applied. */
  private gaps(): Gap[] {
    const model = (mode: ReviewMode) => {
      const r = this.reviewed[mode];
      return r ? reviewedGaps(r, this.text, mode) : [];
    };
    return combineGaps(this.rules, model("quick"), model("deep")).map((g) =>
      this.dismissed.has(dismissKey(g)) ? { ...g, status: "dismissed" } : g,
    );
  }

  private postGaps(): void {
    const gaps = this.gaps();
    const added = this.base === undefined ? [] : addedRanges(this.base, this.text);
    const meter = this.text.trim() ? meterFor(gaps) : null;
    this.post({ type: "gaps", revision: this.revision, gaps, meter, added });
  }

  // Tier 1: rules on every change. Tier 2: small model when typing pauses.
  private onInput(text: string): void {
    if (text !== this.text) {
      const merged = text === this.pendingMerge;
      let change = sessionChange(this.session, this.text, text);
      // a merge rewrites the user's own prompt; it never counts as replacing it
      if (merged && change.end === "replace") change = { start: false };
      if (change.end) this.endSession(change.end); // before the state moves on, so the summary sees the old prompt
      if (change.start) this.startSession();
      if (this.session && !this.session.endedBy && text.trim()) {
        recordRevision(this.session, text, merged ? "merge" : "typed", Date.now());
      }
      this.pendingMerge = undefined;
      this.revision++;
      this.text = text;
      // running requests are for the old revision and would be discarded; stop them
      for (const ctrl of Object.values(this.running)) ctrl?.abort();
      this.running = {};
      // model gaps survive small edits; after 3+ changed words (or a new or empty prompt) they go
      for (const mode of ["quick", "deep"] as const) {
        const last = this.reviewed[mode];
        if (last && (!this.session || !text.trim() || planReview(this.session, last, text).kind !== "keep")) delete this.reviewed[mode];
      }
    }
    if (!text.trim()) this.base = undefined;
    if (text.trim() && this.draft.startedAt === undefined) this.draft.startedAt = Date.now();
    this.analysis = analyze(text, this.workspace.context());
    if (this.draft.firstScore === undefined && text.trim().split(/\s+/).length >= 3) {
      this.draft.firstScore = this.analysis.score;
    }
    this.rules = ruleGaps(text, this.analysis);
    this.postGaps();

    clearTimeout(this.pauseTimer);
    const s = this.session;
    if (!s || s.endedBy || !this.cfg().get<boolean>("quickReviewOnPause", true) || this.running.quick) return;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words < 5 || this.analysis.level === "trivial") return;
    const plan = planReview(s, this.reviewed.quick, text);
    if (plan.kind === "cached") {
      this.reviewed.quick = { text, revision: this.revision, gaps: plan.gaps };
      this.postGaps();
    } else if (plan.kind === "review") {
      this.pauseTimer = setTimeout(() => void this.runReview("quick"), this.cfg().get<number>("pauseMs", 1500));
    }
  }

  // Tier 2 and 3. Results count only for the revision they were asked about.
  private async runReview(mode: ReviewMode): Promise<void> {
    const text = this.text;
    const revision = this.revision;
    const session = this.session;
    if (!text.trim()) return;
    this.running[mode]?.abort();
    const ctrl = new AbortController();
    this.running[mode] = ctrl;
    this.post({ type: "reviewing", mode });

    let error: string | undefined;
    let empty = false;
    try {
      const r: Review = await review(
        text,
        mode,
        this.runner(),
        this.model(mode),
        { analysis: this.analysis, projectNotes: this.workspace.notes(), history: sessionSummary(session) },
        ctrl.signal,
      );
      this.draft[mode === "quick" ? "quickReviews" : "deepReviews"]++;
      this.count(r.usage);
      if (mode === "quick") session?.reviewCache.set(textHash(text), r.gaps); // worth keeping even if the text moved on
      if (revision !== this.revision) return; // the text changed meanwhile
      this.reviewed[mode] = { text, revision, gaps: r.gaps };
      this.postGaps();
      empty = r.gaps.length === 0;
    } catch (e) {
      if (!ctrl.signal.aborted && revision === this.revision) error = (e as Error).message;
    } finally {
      if (this.running[mode] === ctrl) delete this.running[mode];
      this.post({ type: "reviewDone", mode, error, empty });
    }
  }

  private startSession(): void {
    this.session = newSession(randomUUID(), Date.now());
    // nothing carries over from the previous prompt
    this.dismissed.clear();
    this.reviewed = {};
    this.base = undefined;
  }

  private endSession(by: SessionEnd): void {
    const s = this.session;
    if (!s || s.endedBy) return;
    s.endedBy = by;
    s.endedAt = Date.now();
  }

  private dismiss(id: string): void {
    const g = this.gaps().find((x) => x.id === id);
    if (!g) return;
    this.dismissed.add(dismissKey(g));
    this.draft.dismissed.set(g.id, g);
    if (this.session) markGap(this.session, g, "dismissed", undefined, this.revision);
    this.postGaps();
  }

  // The user's answers, written into the prompt. Only on their request; the webview applies it undoably.
  private async merge(answers: { id: string; text: string }[]): Promise<void> {
    const text = this.text;
    const revision = this.revision;
    const byId = new Map(this.gaps().map((g) => [g.id, g]));
    const filled = answers
      .map((a) => ({ gap: byId.get(a.id), answer: a.text.trim() }))
      .filter((a): a is { gap: Gap; answer: string } => !!a.gap && !!a.answer);
    if (!text.trim() || filled.length === 0) return;
    this.running.merge?.abort();
    const ctrl = new AbortController();
    this.running.merge = ctrl;
    try {
      const r = await mergeAnswers(
        text,
        filled.map((a) => ({ question: `${a.gap.question} (${a.gap.reason})`, answer: a.answer })),
        this.runner(),
        this.model("quick"),
        ctrl.signal,
      );
      this.count(r.usage);
      if (revision !== this.revision) throw new Error("The prompt changed while adding your answers. Try again.");
      for (const a of filled) {
        this.draft.answered.set(a.gap.id, a.gap);
        if (this.session) markGap(this.session, a.gap, "answered", a.answer, revision);
      }
      this.base ??= text;
      this.draft.mergedAnswers = true;
      this.pendingMerge = r.text;
      this.post({ type: "merged", text: r.text });
    } catch (e) {
      const changed = revision !== this.revision;
      if (ctrl.signal.aborted && !changed) return;
      this.post({ type: "mergeError", error: changed ? "The prompt changed while adding your answers. Try again." : (e as Error).message });
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
    const openGaps = this.gaps().filter((g) => g.status === "open");
    this.endSession("send");
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
      gaps: {
        open: gapCounts(openGaps),
        answered: gapCounts(d.answered.values()),
        dismissed: gapCounts(d.dismissed.values()),
      },
    });
    this.draft = newDraft();
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
      <div class="actions">
      <button id="copy" class="copy" aria-label="Copy prompt" title="Copy prompt" disabled>
        <svg class="i-copy" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <svg class="i-done" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button id="send" class="send" aria-label="Send to Claude Code" disabled>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      </div>
    </div>
    <p id="status" class="status" role="status"></p>
  </main>
  <script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }
}
