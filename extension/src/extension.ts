import * as path from "node:path";
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { Config, SendRecord } from "@prompt-preflight/core";
import { checkHealth, createProvider, mapError, resolveProfile } from "@prompt-preflight/core";
import { CONSENT_VERSION, consentKey, consentMessage, parseConsent, type IncludeCode } from "./privacy";
import { PromptPanel, showFeedbackError } from "./panel";
import { readModelConfig } from "./modelSettings";
import { JsonlRepository } from "./repository";
import { StudyLog } from "./studyLog";
import { WorkspaceIndex } from "./workspace";

export function activate(context: vscode.ExtensionContext): void {
  const workspace = new WorkspaceIndex();
  const log = new StudyLog(context.globalStorageUri);
  const panel = new PromptPanel(context.extensionUri, workspace, log);

  const storage = context.globalStorageUri.fsPath;
  const drafts = new JsonlRepository<Record<string, unknown>>(path.join(storage, "drafts.jsonl"));
  const questions = new JsonlRepository<Record<string, unknown>>(path.join(storage, "questions.jsonl"));
  const reviews = new JsonlRepository<Record<string, unknown>>(path.join(storage, "reviews.jsonl"));
  const sends = new JsonlRepository<SendRecord>(path.join(storage, "sends.jsonl"));

  // Fire and forget: activation never waits on the answer.
  void ensureConsent(context);
  const config = readModelConfig();
  probeEffortSupport(config);
  void checkActivationHealth(config);

  context.subscriptions.push(
    workspace,
    vscode.window.registerWebviewViewProvider(PromptPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("promptPreflight.focus", () =>
      vscode.commands.executeCommand(`${PromptPanel.viewId}.focus`),
    ),
    vscode.commands.registerCommand("promptPreflight.checkSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor?.document.getText(editor.selection);
      if (!text) return;
      await vscode.commands.executeCommand(`${PromptPanel.viewId}.focus`);
      panel.setText(text);
    }),
    vscode.commands.registerCommand("promptPreflight.openStudyLog", async () => {
      try {
        await vscode.window.showTextDocument(log.uri);
      } catch {
        void vscode.window.showInformationMessage(
          log.enabled ? "No study log yet. Send a prompt first." : "Study logging is off. Enable promptPreflight.studyLog.enabled.",
        );
      }
    }),
    vscode.commands.registerCommand("promptPreflight.clearHistory", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Delete all stored drafts, questions, reviews and send records? Settings and the study log are kept.",
        { modal: true },
        "Delete",
      );
      if (answer !== "Delete") return;
      try {
        const results = await Promise.all([drafts.clear(), questions.clear(), reviews.clear(), sends.clear()]);
        const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
        void vscode.window.showInformationMessage(`Deleted ${deleted} stored event${deleted === 1 ? "" : "s"}.`);
      } catch {
        void vscode.window.showErrorMessage("Prompt Preflight could not clear the stored history.");
      }
    }),
  );
}

export function deactivate(): void {}

/**
 * Activation health check for the quick profile: profile validation plus a
 * cheap CLI presence probe. Non-blocking and non-modal: it runs after
 * activation completes and reports through showFeedbackError, never a modal.
 * A first-call auth problem is not detectable here; the review path maps it.
 */
async function checkActivationHealth(config: Config): Promise<void> {
  try {
    const profile = resolveProfile(config, "quick");
    const provider = createProvider(profile, config);
    const result = await checkHealth(provider, profile, config.claudePath);
    if (!result.ok) showFeedbackError(result.error, () => void checkActivationHealth(readModelConfig()));
  } catch (e) {
    showFeedbackError(mapError(e), () => void checkActivationHealth(readModelConfig()));
  }
}

/**
 * Read-only probe that confirms the installed CLI still exposes --effort.
 * Runs once at activation for Claude profiles only and never sends a model
 * call. A failed probe is silent here; missing-CLI health belongs to the
 * activation health check.
 */
function probeEffortSupport(config: Config): void {
  if (config.provider !== "claude") return;
  execFile(config.claudePath, ["--help"], { timeout: 2000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    if (err || stdout.includes("--effort") || stderr.includes("--effort")) return;
    void vscode.window.showWarningMessage(
      "The Claude Code CLI does not support --effort, so promptPreflight.thinkingEffort will be ignored.",
    );
  });
}

/**
 * First-use consent. Shown only while no valid current-version record exists.
 * A dismissed notice is not a decision and is not persisted.
 */
async function ensureConsent(context: vscode.ExtensionContext): Promise<void> {
  const stored = context.globalState.get<unknown>(consentKey(CONSENT_VERSION));
  if (parseConsent(stored)) return;

  const answer = await vscode.window.showInformationMessage(consentMessage(), { modal: true }, "Accept", "Decline");
  if (answer === undefined) return;

  const record = {
    version: CONSENT_VERSION,
    decision: answer === "Accept" ? ("accepted" as const) : ("declined" as const),
    decidedAt: new Date().toISOString(),
  };
  await context.globalState.update(consentKey(CONSENT_VERSION), record);

  if (record.decision === "declined") await disableIncludeCode();
}

/**
 * On decline, turn includeCode off everywhere. The global off is written first
 * as the baseline for folders without an override, then every workspace folder
 * that defines the value and the workspace scope are updated too. Folder URIs
 * are deduplicated by their string form. Any failed update is recorded and the
 * warning tells the user to switch the setting off by hand.
 */
async function disableIncludeCode(): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const uris: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (!uris.some((u) => u.toString() === folder.uri.toString())) uris.push(folder.uri);
  }
  if (activeUri && !uris.some((u) => u.toString() === activeUri.toString())) uris.push(activeUri);

  const configFor = (uri?: vscode.Uri) => vscode.workspace.getConfiguration("promptPreflight", uri);
  const OFF = "off" as IncludeCode;

  let failed = false;
  try {
    await vscode.workspace
      .getConfiguration("promptPreflight")
      .update("context.includeCode", OFF, vscode.ConfigurationTarget.Global);
  } catch {
    failed = true;
  }

  for (const uri of uris) {
    const inspected = configFor(uri).inspect<IncludeCode>("context.includeCode");
    if (inspected?.workspaceFolderValue === undefined) continue;
    try {
      await configFor(uri).update("context.includeCode", OFF, vscode.ConfigurationTarget.WorkspaceFolder);
    } catch {
      failed = true;
    }
  }

  const workspaceInspected = configFor(activeUri).inspect<IncludeCode>("context.includeCode");
  if (workspaceInspected?.workspaceValue !== undefined) {
    try {
      await configFor(activeUri).update("context.includeCode", OFF, vscode.ConfigurationTarget.Workspace);
    } catch {
      failed = true;
    }
  }

  if (failed) {
    void vscode.window.showWarningMessage(
      "Prompt Preflight could not disable code inclusion. Set promptPreflight.context.includeCode to off in Settings.",
    );
  }
}
