// Prompt-file resolution and fragment building for explicit @ references.
// Pure: the filesystem and editor reads are injected; no vscode import.
import * as path from "node:path";
import {
  SOURCE_PRIORITIES,
  estimateTokens,
  type ContextFragment,
  type ContextSourceResult,
} from "@prompt-preflight/core";
import { isOutsideWorkspace, shouldInclude, type IncludePolicy } from "./privacy";

/** One workspace folder root, in the shape the resolver needs. */
export interface WorkspaceRoot {
  /** String form of the folder URI. */
  uri: string;
  /** Absolute filesystem path. */
  fsPath: string;
}

/** One resolved @ reference. */
export interface ResolvedPromptFile {
  /** The reference text as written in the draft. */
  ref: string;
  /** Workspace-relative POSIX path. */
  path: string;
  /** Absolute filesystem path. */
  fsPath: string;
  /** String form of the owning folder URI. */
  folderUri: string;
}

/** Resolution facts before any file is read. */
export interface PromptFileResolution {
  files: ResolvedPromptFile[];
  missing: string[];
  outside: string[];
  ambiguous: string[];
  duplicate: number;
}

/** One file's text, ready for the source result. */
export interface PromptFileContent {
  path: string;
  folderUri: string;
  content: string;
}

/**
 * Resolves @ references across workspace roots. A reference that exists in
 * more than one root is ambiguous and is never guessed. Paths that leave a
 * root, absolute paths, and drive-letter paths are outside. Duplicate resolved
 * files are counted, not repeated.
 */
export async function resolvePromptFileRefs(
  refs: string[],
  roots: WorkspaceRoot[],
  exists: (fsPath: string) => Promise<boolean>,
  pathApi: Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep"> = path,
): Promise<PromptFileResolution> {
  const files: ResolvedPromptFile[] = [];
  const missing: string[] = [];
  const outside: string[] = [];
  const ambiguous: string[] = [];
  const seen = new Set<string>();
  let duplicate = 0;

  for (const ref of refs) {
    const normalized = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized === "" || isOutsideWorkspace(normalized)) {
      outside.push(ref);
      continue;
    }

    const matches: Array<{ root: WorkspaceRoot; fsPath: string; path: string }> = [];
    for (const root of roots) {
      const candidate = pathApi.resolve(root.fsPath, normalized);
      const relative = pathApi.relative(root.fsPath, candidate);
      if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) continue;
      if (!(await exists(candidate))) continue;
      matches.push({
        root,
        fsPath: candidate,
        path: relative.split(pathApi.sep).join("/").replace(/\\/g, "/"),
      });
    }

    if (matches.length === 0) {
      missing.push(ref);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(ref);
      continue;
    }

    const match = matches[0];
    const key = `${match.root.uri}\0${match.path}`;
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    files.push({ ref, path: match.path, fsPath: match.fsPath, folderUri: match.root.uri });
  }

  return { files, missing, outside, ambiguous, duplicate };
}

/** What the source needs from the resolver and the reader. */
export interface PromptFilesResultInput {
  files: PromptFileContent[];
  policy: IncludePolicy;
  missing: number;
  outside: number;
  ambiguous: number;
  duplicate: number;
  unreadable: number;
}

/**
 * Builds the prompt-files source result. Every resolved file is checked
 * against the privacy policy as an explicitly referenced file, so the
 * exclusion list and the workspace boundary still win.
 */
export function buildPromptFilesResult(input: PromptFilesResultInput): ContextSourceResult {
  const fragments: ContextFragment[] = [];
  let dropped = input.outside + input.ambiguous;

  for (const file of input.files) {
    if (!shouldInclude(file.path, "prompt-file", input.policy)) {
      dropped++;
      continue;
    }
    if (file.content.trim() === "") continue;
    fragments.push({
      source: "prompt-files",
      priority: SOURCE_PRIORITIES["prompt-files"],
      content: file.content,
      tokens: estimateTokens(file.content),
      provenance: {
        kind: "prompt-file",
        path: file.path,
        truncated: false,
        chars: file.content.length,
        folderUri: file.folderUri,
      },
    });
  }

  const details = {
    files: fragments.length,
    dropped,
    missing: input.missing,
    ambiguous: input.ambiguous,
    duplicate: input.duplicate,
    unreadable: input.unreadable,
  };

  if (fragments.length === 0) {
    if (dropped > 0) return { fragments: [], omittedReason: "excluded", details };
    if (input.unreadable > 0) return { fragments: [], omittedReason: "error", details };
    return { fragments: [], omittedReason: "empty", details };
  }
  return { fragments, details };
}
