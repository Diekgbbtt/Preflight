// Basic VS Code context sources (ticket #36). Collectors stay thin: gather
// text, apply #41's privacy predicate, and describe the result. Token caps,
// budget and manifest bookkeeping live in the core assembler.
import * as path from "node:path";
import * as vscode from "vscode";
import {
  SOURCE_PRIORITIES,
  estimateTokens,
  findPathRefs,
  type ContextFragment,
  type ContextKind,
  type ContextSource,
  type ContextSourceId,
  type ContextSourceResult,
  type Range,
} from "@prompt-preflight/core";
import { shouldInclude, type IncludePolicy } from "./privacy";
import { git, type ExecResult } from "./exec";

/** Injectable VS Code surface so the collectors stay thin and testable. */
export interface ContextSourceDeps {
  /** The resolved context folder; recorded in every fragment's provenance. */
  folder?: vscode.WorkspaceFolder;
  /** The effective privacy policy (includeCode already consented). */
  policy: IncludePolicy;
  /** Git executor; defaults to the shared exec.ts helper. */
  git?: (cwd: string, args: string[]) => Promise<ExecResult>;
  /** package.json reader; defaults to vscode.workspace.fs.readFile. */
  readFile?: (uri: vscode.Uri) => Thenable<Uint8Array>;
}

/** The string form of the resolved folder, when one exists. */
function folderUriOf(deps: ContextSourceDeps): string | undefined {
  return deps.folder?.uri.toString();
}

/** Builds one fragment with the assembler's expected provenance shape. */
function fragment(
  deps: ContextSourceDeps,
  source: ContextSourceId,
  kind: ContextKind,
  content: string,
  extra?: { path?: string; range?: Range },
): ContextFragment {
  const folderUri = folderUriOf(deps);
  return {
    source,
    priority: SOURCE_PRIORITIES[source],
    content,
    tokens: estimateTokens(content),
    provenance: {
      kind,
      ...(extra?.path !== undefined ? { path: extra.path } : {}),
      ...(extra?.range ? { range: extra.range } : {}),
      truncated: false,
      chars: content.length,
      ...(folderUri !== undefined ? { folderUri } : {}),
    },
  };
}

/**
 * The workspace-relative POSIX path of a document, or "" for untitled and
 * non-file URIs. A path outside the given folder starts with "..", which the
 * privacy predicate rejects.
 */
export function activePathFor(uri: vscode.Uri, folder?: vscode.WorkspaceFolder): string {
  if (uri.scheme !== "file") return "";
  if (!folder) {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/").replace(/^\.\//, "");
  }
  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, "/");
}

/**
 * Resolves the folder that owns the context: the first folder where a draft
 * path reference exists, else the active editor's folder. Never a whole-repo
 * index; the callers decide what to collect.
 */
export async function resolveContextFolder(draft: string, activeUri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  for (const ref of findPathRefs(draft)) {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ref.text));
        return folder;
      } catch {
        // Not in this folder; try the next one.
      }
    }
  }
  return activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
}

/** The user's current selection. It replaces the active file when non-empty. */
export function createSelectionSource(deps: ContextSourceDeps): ContextSource {
  return {
    id: "selection",
    priority: SOURCE_PRIORITIES.selection,
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return { fragments: [], omittedReason: "empty" };
      const path = activePathFor(editor.document.uri, deps.folder);
      if (!shouldInclude(path, "selection", deps.policy)) return { fragments: [], omittedReason: "excluded" };
      const content = editor.document.getText(editor.selection);
      if (content.trim() === "") return { fragments: [], omittedReason: "empty" };
      return {
        fragments: [
          fragment(deps, "selection", "selection", content, {
            path,
            range: {
              start: editor.document.offsetAt(editor.selection.start),
              end: editor.document.offsetAt(editor.selection.end),
            },
          }),
        ],
      };
    },
  };
}

/** The whole active document, unless a selection replaces it. */
export function createActiveEditorSource(deps: ContextSourceDeps): ContextSource {
  return {
    id: "active-editor",
    priority: SOURCE_PRIORITIES["active-editor"],
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      const editor = vscode.window.activeTextEditor;
      if (!editor) return { fragments: [], omittedReason: "empty" };
      if (!editor.selection.isEmpty) return { fragments: [], omittedReason: "empty" };
      const path = activePathFor(editor.document.uri, deps.folder);
      if (!shouldInclude(path, "active-file", deps.policy)) return { fragments: [], omittedReason: "excluded" };
      const content = editor.document.getText();
      if (content === "") return { fragments: [], omittedReason: "empty" };
      return { fragments: [fragment(deps, "active-editor", "active-file", content, { path })] };
    },
  };
}

/** Other eligible open documents; never the active file or the selection. */
export function createOpenEditorsSource(deps: ContextSourceDeps): ContextSource {
  return {
    id: "open-editors",
    priority: SOURCE_PRIORITIES["open-editors"],
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      const active = vscode.window.activeTextEditor?.document;
      const fragments: ContextFragment[] = [];
      for (const document of vscode.workspace.textDocuments) {
        if (document === active) continue;
        const path = activePathFor(document.uri, deps.folder);
        if (path === "" || !shouldInclude(path, "open-editor", deps.policy)) continue;
        const content = document.getText();
        if (content.trim() === "") continue;
        fragments.push(fragment(deps, "open-editors", "open-editor", content, { path }));
      }
      if (fragments.length === 0) return { fragments: [], omittedReason: "empty" };
      return { fragments, details: { files: fragments.length } };
    },
  };
}

/** Strips surrounding quotes from a diff path token. */
function unquote(token: string): string {
  const trimmed = token.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/** Extracts the b/ path of one diff section; undefined when it cannot be vetted. */
function diffSectionPath(section: string): string | undefined {
  const lines = section.split("\n");
  const plus = lines.find((line) => line.startsWith("+++ "));
  if (plus) {
    const rest = unquote(plus.slice(4));
    if (rest.startsWith("b/")) return rest.slice(2).replace(/\\/g, "/");
  }
  // Deleted files have no b/ side in the +++ line; the header still names both.
  const header = lines.find((line) => line.startsWith("diff --git "));
  if (header) {
    const body = header.slice("diff --git ".length);
    const match = /^(?:"a\/(.*)"|a\/(\S+)) (?:"b\/(.*)"|b\/(\S+))$/.exec(body);
    if (match) return unquote(match[3] ?? match[4] ?? "").replace(/\\/g, "/");
  }
  return undefined;
}

/** Splits a unified diff into sections, one per `diff --git` header. */
function splitDiffSections(diff: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.filter((section) => section.trim() !== "");
}

/** The uncommitted diff, filtered by the privacy policy. Never executed twice. */
export function createGitDiffSource(deps: ContextSourceDeps): ContextSource {
  return {
    id: "git-diff",
    priority: SOURCE_PRIORITIES["git-diff"],
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      if (!deps.folder) return { fragments: [], omittedReason: "unsupported" };
      const result = await (deps.git ?? git)(deps.folder.uri.fsPath, ["diff", "HEAD", "--no-ext-diff", "--unified=3"]);
      if (!result.ok) return { fragments: [], omittedReason: "unsupported" };
      if (result.stdout.trim() === "") return { fragments: [], omittedReason: "empty" };
      const included: string[] = [];
      let dropped = 0;
      for (const section of splitDiffSections(result.stdout)) {
        const path = diffSectionPath(section);
        if (path === undefined || !shouldInclude(path, "workspace", deps.policy)) {
          dropped++;
          continue;
        }
        included.push(section);
      }
      if (included.length === 0) {
        return { fragments: [], omittedReason: dropped > 0 ? "excluded" : "empty", details: { files: 0, dropped } };
      }
      return {
        fragments: [fragment(deps, "git-diff", "git-diff", included.join("\n"))],
        details: { files: included.length, dropped },
      };
    },
  };
}

/** The workspace's `scripts.test` string. It is never executed. */
export function createTestCommandSource(deps: ContextSourceDeps): ContextSource {
  return {
    id: "test-command",
    priority: SOURCE_PRIORITIES["test-command"],
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      if (!deps.folder) return { fragments: [], omittedReason: "unsupported" };
      const readFile = deps.readFile ?? ((uri: vscode.Uri) => vscode.workspace.fs.readFile(uri));
      let script: unknown;
      try {
        const raw = await readFile(vscode.Uri.joinPath(deps.folder.uri, "package.json"));
        script = (JSON.parse(new TextDecoder().decode(raw)) as { scripts?: { test?: unknown } }).scripts?.test;
      } catch {
        return { fragments: [], omittedReason: "empty" };
      }
      if (typeof script !== "string" || script.trim() === "") return { fragments: [], omittedReason: "empty" };
      return {
        fragments: [fragment(deps, "test-command", "test-command", script, { path: "package.json" })],
        details: { script: "test" },
      };
    },
  };
}
