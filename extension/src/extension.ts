import * as vscode from "vscode";
import { CONSENT_VERSION, consentKey, consentMessage, parseConsent, type IncludeCode } from "./privacy";
import { PromptPanel } from "./panel";
import { StudyLog } from "./studyLog";
import { WorkspaceIndex } from "./workspace";

export function activate(context: vscode.ExtensionContext): void {
  const workspace = new WorkspaceIndex();
  const log = new StudyLog(context.globalStorageUri);
  const panel = new PromptPanel(context.extensionUri, workspace, log);

  // Fire and forget: activation never waits on the answer.
  void ensureConsent(context);

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
  );
}

export function deactivate(): void {}

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

/** On decline, turn includeCode off where it is currently defined, else globally. */
async function disableIncludeCode(): Promise<void> {
  const config = vscode.workspace.getConfiguration("promptPreflight", vscode.window.activeTextEditor?.document.uri);
  const inspected = config.inspect<IncludeCode>("context.includeCode");
  const scopes = [
    { scope: "workspaceFolderValue" as const, target: vscode.ConfigurationTarget.WorkspaceFolder },
    { scope: "workspaceValue" as const, target: vscode.ConfigurationTarget.Workspace },
    { scope: "globalValue" as const, target: vscode.ConfigurationTarget.Global },
  ];

  for (const { scope, target } of scopes) {
    if (inspected?.[scope] === undefined) continue;
    try {
      await config.update("context.includeCode", "off" as IncludeCode, target);
      return;
    } catch {
      break;
    }
  }

  try {
    await config.update("context.includeCode", "off" as IncludeCode, vscode.ConfigurationTarget.Global);
  } catch {
    void vscode.window.showWarningMessage(
      "Prompt Preflight could not disable code inclusion. Set promptPreflight.context.includeCode to off in Settings.",
    );
  }
}
