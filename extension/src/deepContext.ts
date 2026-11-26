// Deep review context sources (#46), limited to the #18 decision: T0 and T1, no workspace search.
import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import {
  estimateTokens,
  findPromptFileRefs,
  hashPrompt,
  type Clock,
  type ContextSource,
  type Event,
  type ModelCapabilities,
  type SendRecord,
} from "@prompt-preflight/core";
import { createGitDiffSource, createPromptFilesSource } from "./contextSources";
import { createCodeTools } from "./codeTools";
import { createDiagnosticsSource, createSymbolsSource } from "./languageContext";
import { resolvePromptFileRefs } from "./promptFiles";
import { redact, type IncludeCode, type IncludePolicy } from "./privacy";
import { createSessionSliceSource } from "./sessionSlice";
import { createVscodeCodeTools } from "./vscodeCodeTools";

export interface DeepContextDeps {
  folders: readonly vscode.WorkspaceFolder[];
  /** Effective value after consent (consentedIncludeCode), never the raw setting. */
  includeCode: IncludeCode;
  /** WorkspaceIndex.notes(): file names only, no code. */
  notes: string;
  sends: Array<Event<SendRecord>>;
  sendId?: string;
  clock: Clock;
  capabilities: ModelCapabilities;
  rgPath?: string;
}

/** T0 file-name notes. No code, so no consent is needed. */
function fileNamesSource(notes: string): ContextSource {
  return {
    id: "file-names",
    priority: 20,
    collect: async () =>
      notes.trim()
        ? {
            fragments: [
              {
                source: "file-names",
                priority: 20,
                content: notes,
                tokens: estimateTokens(notes),
                provenance: { kind: "prompt-file", truncated: false, chars: notes.length },
              },
            ],
          }
        : { fragments: [], omittedReason: "empty" as const },
  };
}

/**
 * The deep review sources for one draft. @ references are resolved first so the
 * same list feeds every policy (handoff "Draft input to context bundle").
 * Under includeCode "off" the code sources still run and report "excluded",
 * so the review can tell the user why its questions stay at the intent level.
 */
export async function deepSources(draft: string, deps: DeepContextDeps): Promise<ContextSource[]> {
  const folders = [...deps.folders];
  // shortcut: git diff, code tools and the session slice use the first folder only; resolve per folder for multi-root.
  const folder = folders[0];
  const roots = folders.map((f) => ({ uri: f.uri.toString(), fsPath: f.uri.fsPath }));
  const exists = async (fsPath: string) => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
      return true;
    } catch {
      return false;
    }
  };
  const refs = findPromptFileRefs(draft).map((r) => r.text);
  const resolved = refs.length ? (await resolvePromptFileRefs(refs, roots, exists, realpath)).files : [];
  const promptFiles = resolved.map((f) => f.path);
  const policy: IncludePolicy = { includeCode: deps.includeCode, promptFiles };

  const sources: ContextSource[] = [fileNamesSource(deps.notes), createPromptFilesSource({ folders, policy, draft })];
  if (!folder) return sources;

  const cwd = folder.uri.fsPath;
  const adapter = createVscodeCodeTools({ cwd, rgPath: deps.rgPath });
  const tools = createCodeTools({ protocol: adapter, textSearch: adapter, policy, cwd });
  const folderUri = folder.uri.toString();
  sources.push(
    createGitDiffSource({ folder, policy }),
    // shortcut: symbols for the first referenced file only (one "symbols" source per bundle).
    createSymbolsSource({ tools, policy, folderUri, activePath: promptFiles[0] }),
    createDiagnosticsSource({ tools, policy, folderUri, openDocuments: resolved.map((f) => ({ uri: vscode.Uri.file(f.fsPath).toString(), path: f.path })) }),
    createSessionSliceSource({
      folderUri,
      sends: deps.sends,
      sendId: deps.sendId,
      promptHash: hashPrompt(draft),
      clock: deps.clock,
      capabilities: deps.capabilities,
      includeCode: deps.includeCode,
      promptFiles,
      redact,
    }),
  );
  return sources;
}
