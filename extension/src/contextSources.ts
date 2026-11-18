// Basic VS Code context sources (ticket #36). Collectors stay thin: gather
// text, apply #41's privacy predicate, and describe the result. Token caps,
// budget and manifest bookkeeping live in the core assembler.
import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import {
  SOURCE_PRIORITIES,
  estimateTokens,
  findPromptFileRefs,
  type ContextFragment,
  type ContextKind,
  type ContextSource,
  type ContextSourceId,
  type ContextSourceResult,
  type Range,
} from "@prompt-preflight/core";
import { shouldInclude, type IncludePolicy } from "./privacy";
import { git, type ExecResult } from "./exec";
import {
  buildPromptFilesResult,
  resolvePromptFileRefs,
  type PromptFileContent,
} from "./promptFiles";

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

/** Inputs of the prompt-files source. */
export interface PromptFilesSourceDeps {
  /** Every workspace root, in order. */
  folders: vscode.WorkspaceFolder[];
  /** Effective privacy policy (includeCode already consented). */
  policy: IncludePolicy;
  /** The draft whose @ references are resolved. */
  draft: string;
  /** Open-document reader; defaults to vscode.workspace.openTextDocument. */
  readText?: (uri: vscode.Uri) => Promise<string>;
}

/**
 * The prompt-files source: resolves explicit @ references, reads each file,
 * and delegates policy, provenance, and detail counts to the pure builder.
 * It never scans the workspace and never reads an unreferenced file.
 */
export function createPromptFilesSource(deps: PromptFilesSourceDeps): ContextSource {
  return {
    id: "prompt-files",
    priority: SOURCE_PRIORITIES["prompt-files"],
    collect: async (signal?: AbortSignal): Promise<ContextSourceResult> => {
      signal?.throwIfAborted();
      const refs = findPromptFileRefs(deps.draft).map((ref) => ref.text);
      if (refs.length === 0) return { fragments: [], omittedReason: "empty" };

      const roots = deps.folders.map((folder) => ({ uri: folder.uri.toString(), fsPath: folder.uri.fsPath }));
      const resolution = await resolvePromptFileRefs(refs, roots, async (fsPath) => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
          return true;
        } catch {
          return false;
        }
      }, realpath);

      const resolvedPolicy: IncludePolicy = { ...deps.policy, promptFiles: resolution.files.map((file) => file.path) };
      const allowed = resolution.files.filter((file) => shouldInclude(file.path, "prompt-file", resolvedPolicy));
      const excluded = resolution.excluded.length + resolution.files.length - allowed.length;

      const readText =
        deps.readText ?? ((uri: vscode.Uri) => vscode.workspace.openTextDocument(uri).then((document) => document.getText()));
      const contents: PromptFileContent[] = [];
      let unreadable = 0;
      for (const file of allowed) {
        signal?.throwIfAborted();
        try {
          contents.push({
            path: file.path,
            folderUri: file.folderUri,
            content: await readText(vscode.Uri.file(file.fsPath)),
          });
        } catch {
          unreadable++;
        }
      }

      return buildPromptFilesResult({
        files: contents,
        policy: resolvedPolicy,
        missing: resolution.missing.length,
        outside: resolution.outside.length,
        ambiguous: resolution.ambiguous.length,
        excluded,
        duplicate: resolution.duplicate,
        unreadable,
      });
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
