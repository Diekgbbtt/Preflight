// Explicit @ file references in the draft. Pure: no filesystem, no vscode.
// The resolver owns existence and workspace-boundary checks; this module only
// decides which tokens look like file paths.
import type { Range } from "./types";

/** One @ reference: the path text and its character range in the draft. */
export interface PromptFileRef extends Range {
  text: string;
}

// Start of text, whitespace, or an opening bracket before @. The path may be
// quoted to allow spaces. Unquoted tokens stop at whitespace and brackets.
const MENTION = /(^|[\s([{])@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'<>()[\]{}]+))/g;

// Sentence punctuation is not part of a path.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** True when the token names a file: a non-empty final segment with an extension. */
function isFilePath(token: string): boolean {
  if (token === "" || token.endsWith("/") || token.endsWith("\\")) return false;
  const segments = token.split(/[\\/]/);
  return /\.[A-Za-z0-9]+$/.test(segments[segments.length - 1]);
}

/**
 * Finds unique @ file references in prompt order. Email addresses, decorators,
 * npm scopes without an extension, bare paths, and directory references are
 * ignored. Quotes are stripped from the returned text.
 */
export function findPromptFileRefs(text: string): PromptFileRef[] {
  const refs: PromptFileRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    const token = raw.replace(TRAILING_PUNCTUATION, "");
    if (!isFilePath(token) || seen.has(token)) continue;
    seen.add(token);
    const start = match.index! + match[0].indexOf(raw);
    refs.push({ text: token, start, end: start + token.length });
  }
  return refs;
}
