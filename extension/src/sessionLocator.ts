// Pure session locator for the current-session slice (ticket #38).
// Never touches the filesystem: candidates are discovered by sessionSlice.ts
// and passed in. Uses only the injected clock; no Date.now, no vscode.
import type { Clock, Event, SendRecord } from "@prompt-preflight/core";

/** Providers with a session store this reader understands. */
export type SessionProvider = "claude" | "codex";

/** One discoverable session file, keyed by workspace folder URI. */
export interface SessionCandidate {
  sessionId: string;
  provider: SessionProvider;
  folderUri: string;
  filePath: string;
  mtimeMs: number;
  startedAt?: string;
  turnCount?: number;
}

/** Pure locator input. `sends` may hold several versions of one send id. */
export interface LocatorInput {
  sendId?: string;
  folderUri: string;
  promptHash?: string;
  sends: Array<Event<SendRecord>>;
  candidates: SessionCandidate[];
  clock: Clock;
}

export type SessionLocation =
  | { kind: "found"; candidate: SessionCandidate }
  | { kind: "ambiguous"; candidates: SessionCandidate[] }
  | { kind: "none" };

/** Hash-match window for path 2: 30 minutes. */
export const SEND_MATCH_WINDOW_MS = 30 * 60 * 1000;
/** Recency window for path 3: 24 hours. */
export const SESSION_AGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Ambiguity window for path 3: 2 minutes. */
export const AMBIGUITY_WINDOW_MS = 2 * 60 * 1000;

/**
 * Stable canonical form of a folder URI across POSIX, Windows drive and UNC
 * paths. Percent-encoding and a trailing separator normalize away, a Windows
 * drive letter is lowercased, and localhost folds into the empty host.
 * Non-file URIs and invalid file URIs pass through unchanged.
 */
export function canonicalFolderUri(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return uri;
  }
  if (url.protocol !== "file:") return uri;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return uri;
  }
  if (pathname.length > 1 && pathname.endsWith("/") && !/^\/[A-Za-z]:\/$/.test(pathname)) {
    pathname = pathname.slice(0, -1);
  }
  if (/^\/[A-Za-z]:\//.test(pathname)) {
    pathname = "/" + pathname[1].toLowerCase() + pathname.slice(2);
  }
  const host = url.host === "localhost" ? "" : url.host.toLowerCase();
  return `file://${host}${encodeURI(pathname)}`;
}

/**
 * Claude Code's project-directory encoding. Every character outside
 * [A-Za-z0-9_-] becomes "-", so POSIX "/Users/x" is "-Users-x" and Windows
 * "C:\\Users\\x" is "C--Users-x". The rule matches the Claude binary's
 * sanitizer and the real POSIX directory names.
 */
export function encodeClaudeProjectPath(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9\-_]/g, "-");
  return sanitized === "" ? "unknown" : sanitized;
}

/** Folds send versions to the highest seq per envelope id. Order of ids follows first appearance. */
function foldSends(sends: Array<Event<SendRecord>>): Map<string, Event<SendRecord>> {
  const folded = new Map<string, Event<SendRecord>>();
  for (const event of sends) {
    const current = folded.get(event.id);
    if (!current || event.seq > current.seq) folded.set(event.id, event);
  }
  return folded;
}

/** Later send wins: ts descending, then seq descending. */
function isLater(a: Event<SendRecord>, b: Event<SendRecord>): boolean {
  const at = Date.parse(a.ts);
  const bt = Date.parse(b.ts);
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at > bt;
  return a.seq > b.seq;
}

/** Finds a candidate for one linked session inside one folder. */
function findLinked(candidates: SessionCandidate[], folderUri: string, sessionId: string): SessionCandidate | undefined {
  return candidates.find((c) => c.sessionId === sessionId && canonicalFolderUri(c.folderUri) === folderUri);
}

/** Sorts candidates for the ambiguous result: mtime descending, then session id ascending. */
function sortAmbiguous(candidates: SessionCandidate[]): SessionCandidate[] {
  return [...candidates].sort(
    (a, b) => (b.mtimeMs - a.mtimeMs) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0),
  );
}

/**
 * Resolves one session candidate, pure:
 * 1. sendId exact match against the highest-seq send with that envelope id.
 * 2. folder URI plus promptHash against sends inside a 30-minute window.
 * 3. most recently modified folder session within 24 hours.
 * Ambiguity inside the 2-minute window is returned, never guessed.
 */
export function locateSession(input: LocatorInput): SessionLocation {
  const folder = canonicalFolderUri(input.folderUri);
  const folded = foldSends(input.sends);
  const now = input.clock.now();

  // Path 1: the linked session of a re-reviewed send wins over every heuristic.
  if (input.sendId !== undefined) {
    const linked = folded.get(input.sendId);
    if (linked?.sessionId !== undefined) {
      const sendFolder = canonicalFolderUri(linked.folderUri);
      const candidate = findLinked(input.candidates, sendFolder, linked.sessionId);
      if (candidate) return { kind: "found", candidate };
      // The linked file is gone: never link a different session.
      return { kind: "none" };
    }
    // No send record for this id, or it carries no session yet: fall through.
  }

  // Path 2: an edited draft links to the session that handled the same prompt.
  if (input.promptHash !== undefined) {
    const cutoff = now - SEND_MATCH_WINDOW_MS;
    let match: Event<SendRecord> | undefined;
    for (const event of folded.values()) {
      if (event.promptHash !== input.promptHash) continue;
      if (canonicalFolderUri(event.folderUri) !== folder) continue;
      const ts = Date.parse(event.ts);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      if (!match || isLater(event, match)) match = event;
    }
    if (match?.sessionId !== undefined) {
      const sendFolder = canonicalFolderUri(match.folderUri);
      const candidate = findLinked(input.candidates, sendFolder, match.sessionId);
      if (candidate) return { kind: "found", candidate };
      // The matched file is absent: fall through to recency.
    }
  }

  // Path 3: pre-send recency, bounded to 24 hours.
  const fresh = input.candidates.filter(
    (c) => canonicalFolderUri(c.folderUri) === folder && c.mtimeMs >= now - SESSION_AGE_WINDOW_MS,
  );
  if (fresh.length === 0) return { kind: "none" };
  const latest = fresh.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const near = fresh.filter((c) => latest.mtimeMs - c.mtimeMs <= AMBIGUITY_WINDOW_MS);
  if (near.length >= 2) return { kind: "ambiguous", candidates: sortAmbiguous(near) };
  return { kind: "found", candidate: latest };
}
