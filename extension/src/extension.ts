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
