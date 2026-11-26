import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { clearTraceFiles } from "./writer";
import { debugLogFile, resolveDebugLogDir } from "./path";
import { OtelDebugTrace } from "./trace";
import {
  NOOP_REVIEW_TRACE,
  type DebugLevel,
  type DebugTrace,
  type ReviewTrace,
  type ReviewTraceMeta,
} from "./types";

const NOTICE_KEY = "promptPreflight.debugNotice.v1";
const CHANNEL_NAME = "Prompt Preflight Debug";

/** Owns the optional debug trace and all VS Code lifecycle wiring. */
export class DebugController implements DebugTrace {
  private trace: OtelDebugTrace | undefined;
  private traceDir: string | undefined;
  private channel: vscode.LogOutputChannel | undefined;
  private dir: string;
  private configListener: vscode.Disposable | undefined;
  private reloading = false;
  private reloadPending = false;
  private shutdownOnce = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.dir = this.resolvedDir();
  }

  async start(): Promise<void> {
    this.configListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("promptPreflight.debug") ||
        event.affectsConfiguration("promptPreflight.debugLogDir")
      ) {
        void this.reload();
      }
    });
    await this.reload();
  }

  /** Test/e2e seam: pre-accept the first-enable notice. */
  async acceptNotice(): Promise<void> {
    await this.context.globalState.update(NOTICE_KEY, true);
  }

  startReview(meta: ReviewTraceMeta): ReviewTrace {
    try {
      return this.trace?.startReview(meta) ?? NOOP_REVIEW_TRACE;
    } catch {
      return NOOP_REVIEW_TRACE;
    }
  }

  event(name: string, attributes: Record<string, unknown> = {}, level: DebugLevel = "info"): void {
    try {
      this.trace?.event(name, attributes, level);
    } catch {
      // Debug tracing must never fail the review path.
    }
  }

  storage(action: string, attributes: Record<string, unknown> = {}): void {
    try {
      this.trace?.storage(action, attributes);
    } catch {
      // Debug tracing must never fail the review path.
    }
  }

  showLog(): void {
    if (this.channel) {
      try {
        this.channel.show(true);
      } catch {
        // The channel may have been disposed during a settings change.
      }
      return;
    }
    void vscode.window.showInformationMessage(
      "Debug logging is off. Set promptPreflight.debug to true, then run a review.",
    );
  }

  async openLogFile(): Promise<void> {
    const file = debugLogFile(this.dir);
    try {
      await fs.stat(file);
    } catch {
      void vscode.window.showInformationMessage(
        `No debug log at ${file}. Enable promptPreflight.debug and run a review first.`,
      );
      return;
    }
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Prompt Preflight could not open the debug log: ${message}`);
    }
  }

  async clear(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      `Delete all debug trace files in ${this.dir}? The study log and stored reviews are kept.`,
      { modal: true },
      "Delete",
    );
    if (answer !== "Delete") return;
    await this.disposeTrace();
    this.disposeChannel();
    let deleted = 0;
    try {
      deleted = await clearTraceFiles(this.dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Prompt Preflight could not delete the debug trace: ${message}`);
      return;
    }
    await this.reload();
    void vscode.window.showInformationMessage(
      deleted === 1 ? "Deleted the debug trace file." : `Deleted ${deleted} debug trace files.`,
    );
  }

  /** Called by the VS Code subscription and by deactivate. */
  async dispose(): Promise<void> {
    await this.shutdown();
  }

  /** Idempotent asynchronous shutdown used by deactivate. */
  async shutdown(): Promise<void> {
    if (this.shutdownOnce) return;
    this.shutdownOnce = true;
    this.configListener?.dispose();
    this.configListener = undefined;
    await this.disposeTrace();
    this.disposeChannel();
  }

  private async reload(): Promise<void> {
    if (this.shutdownOnce) return;
    if (this.reloading) {
      this.reloadPending = true;
      return;
    }
    this.reloading = true;
    try {
      const config = vscode.workspace.getConfiguration("promptPreflight");
      const enabled = config.get<boolean>("debug", false);
      const setting = config.get<string>("debugLogDir", "");
      const dir = resolveDebugLogDir(this.context.globalStorageUri.fsPath, setting);
      this.dir = dir;

      if (!enabled) {
        await this.disposeTrace();
        this.disposeChannel();
        return;
      }

      let accepted = false;
      try {
        accepted = await this.confirmNotice(dir);
      } catch (error) {
        console.error("Prompt Preflight debug notice failed", error);
        try {
          await config.update("debug", false, vscode.ConfigurationTarget.Global);
        } catch {
          // Keep the debug trace off even when the setting cannot be rewritten.
        }
        await this.disposeTrace();
        this.disposeChannel();
        return;
      }
      if (!accepted) {
        await config.update("debug", false, vscode.ConfigurationTarget.Global);
        await this.disposeTrace();
        this.disposeChannel();
        return;
      }

      const channel = this.ensureChannel();
      if (this.trace && this.traceDir === dir) return;
      await this.disposeTrace();
      try {
        this.trace = OtelDebugTrace.create({
          dir,
          channel,
          resourceAttributes: this.resourceAttributes(),
          sessionAttributes: this.sessionAttributes(dir),
          version: this.extensionVersion(),
        });
        this.traceDir = dir;
        this.trace.event(
          "config.change",
          {
            "prompt_preflight.setting.debug": true,
            "prompt_preflight.setting.debug_log_dir": dir,
          },
          "info",
        );
      } catch (error) {
        this.trace = undefined;
        this.traceDir = undefined;
        const message = error instanceof Error ? error.message : String(error);
        channel.error(`Debug trace could not start: ${message}`);
        void vscode.window.showWarningMessage(`Prompt Preflight debug logging could not start: ${message}`);
      }
    } finally {
      this.reloading = false;
      if (this.reloadPending) {
        this.reloadPending = false;
        void this.reload();
      }
    }
  }

  private async confirmNotice(dir: string): Promise<boolean> {
    if (this.context.globalState.get<boolean>(NOTICE_KEY)) return true;
    const answer = await vscode.window.showWarningMessage(
      `Prompt Preflight debug logging stores full prompts, code, model responses, and process output in a local JSONL file at ${dir}. The file is not encrypted and is not uploaded. Enable debug logging?`,
      { modal: true },
      "Enable debug logging",
    );
    if (answer !== "Enable debug logging") {
      void vscode.window.showInformationMessage("Prompt Preflight debug logging stays off.");
      return false;
    }
    await this.context.globalState.update(NOTICE_KEY, true);
    return true;
  }

  private ensureChannel(): vscode.LogOutputChannel {
    if (!this.channel) this.channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
    return this.channel;
  }

  private disposeChannel(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }

  private async disposeTrace(): Promise<void> {
    const trace = this.trace;
    this.trace = undefined;
    this.traceDir = undefined;
    if (!trace) return;
    try {
      await trace.dispose();
    } catch (error) {
      console.error("Prompt Preflight debug trace shutdown failed", error);
    }
  }

  private resolvedDir(): string {
    const config = vscode.workspace.getConfiguration("promptPreflight");
    return resolveDebugLogDir(
      this.context.globalStorageUri.fsPath,
      config.get<string>("debugLogDir", ""),
    );
  }

  private extensionVersion(): string {
    const version = (this.context.extension.packageJSON as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.1.0";
  }

  private resourceAttributes(): Record<string, unknown> {
    return {
      "service.name": "prompt-preflight",
      "service.version": this.extensionVersion(),
      "vscode.version": vscode.version,
      "vscode.extension.id": this.context.extension.id,
      "process.pid": process.pid,
      "process.runtime.name": "nodejs",
      "process.runtime.version": process.versions.node,
      "os.type": os.type(),
      "os.version": os.release(),
      "host.arch": process.arch,
    };
  }

  private sessionAttributes(dir: string): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration("promptPreflight");
    return {
      "prompt_preflight.workspace_roots": (vscode.workspace.workspaceFolders ?? [])
        .map((folder) => folder.uri.toString())
        .join(", "),
      "prompt_preflight.debug_log_dir": dir,
      "prompt_preflight.setting.provider": config.get("provider"),
      "prompt_preflight.setting.model": config.get("model"),
      "prompt_preflight.setting.thinking_effort": config.get("thinkingEffort"),
      "prompt_preflight.setting.quick_model": config.get("quickModel"),
      "prompt_preflight.setting.deep_model": config.get("deepModel"),
      "prompt_preflight.setting.claude_path": config.get("claudePath"),
      "prompt_preflight.setting.pause_ms": config.get("pauseMs"),
      "prompt_preflight.setting.send_to": config.get("sendTo"),
      "prompt_preflight.setting.include_code": config.get("context.includeCode"),
      "prompt_preflight.setting.study_log": config.get("studyLog.enabled"),
    };
  }
}

/** The package-private directory helper is exported for the controller tests. */
export function debugTraceFile(dir: string): string {
  return path.join(dir, "llm-trace.jsonl");
}
