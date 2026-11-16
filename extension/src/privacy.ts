// Pure privacy policy and redaction for prompt Preflight.
// Must not import vscode: the policy is testable without a VS Code mock.
import { SECRETS } from "@prompt-preflight/core";

/** Bump when the consent text changes materially; older stored decisions expire. */
export const CONSENT_VERSION = 1;

/** Global-state key under which a consent decision is stored. */
export function consentKey(version: number): string {
  return `promptPreflight.consent.v${version}`;
}

/** A persisted consent decision. Stored in globalState, never in workspace settings. */
export interface ConsentRecord {
  version: number;
  decision: "accepted" | "declined";
  decidedAt: string;
}

/** Accepts only a current-version, well-formed record. Returns null otherwise; never throws. */
export function parseConsent(stored: unknown): ConsentRecord | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  const record = stored as Record<string, unknown>;
  if (record.version !== CONSENT_VERSION) return null;
  if (record.decision !== "accepted" && record.decision !== "declined") return null;
  if (typeof record.decidedAt !== "string") return null;
  return { version: record.version, decision: record.decision, decidedAt: record.decidedAt };
}

/** Result of redacting one text: the final text and the number of secret matches replaced. */
export interface RedactionResult {
  text: string;
  count: number;
}

// One character no SECRETS pattern can match. Used to mark replaced spans so a
// later pattern cannot match or double-count them.
const SENTINEL = "\u0000";

/**
 * Replaces every SECRETS match with `[redacted]` and reports how many were replaced.
 * Patterns are applied sequentially to the updated text with fresh regex clones,
 * so shared global regex state and cross-pattern double counting are impossible.
 * Never logs the matches or the original text.
 */
export function redact(text: string): RedactionResult {
  let masked = text;
  let count = 0;
  for (const pattern of SECRETS) {
    const re = new RegExp(pattern.source, pattern.flags);
    masked = masked.replace(re, () => {
      count++;
      return SENTINEL;
    });
  }
  return { text: masked.split(SENTINEL).join("[redacted]"), count };
}

/** How much code context may be included in a model call. */
export type IncludeCode = "off" | "active-file" | "workspace";

/** The kind of text a source would include. Only code-bearing kinds reach shouldInclude. */
export type IncludeKind = "selection" | "active-file" | "open-editor" | "workspace" | "diagnostic" | "session";

/** The current privacy policy: the setting plus the active document path. */
export interface IncludePolicy {
  includeCode: IncludeCode;
  /** Workspace-relative POSIX path of the active document, when there is one. */
  activePath?: string;
}

// Excluded names, matched case-insensitively. Secret-bearing file names by
// basename, plus dependency and git directories by segment.
const EXCLUDED_DIR_SEGMENTS = new Set(["node_modules", ".git"]);
const EXCLUDED_BASENAMES = new Set(["credentials.json", "id_rsa", "id_ed25519"]);

/** True when the workspace-relative path names an excluded secret-bearing file or directory. */
function isExcludedPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((s) => EXCLUDED_DIR_SEGMENTS.has(s.toLowerCase()))) return true;
  const base = segments[segments.length - 1].toLowerCase();
  return (
    EXCLUDED_BASENAMES.has(base) ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}

/** True when the path cannot be resolved inside a workspace folder. */
function isOutsideWorkspace(path: string): boolean {
  return path.startsWith("/") || path.split("/").includes("..");
}

/**
 * Decides whether a code source may enter the model call. Pure and testable.
 * `path` is a workspace-relative POSIX path, or "" for an untitled or virtual document.
 * Under `off`, every kind is excluded. Under `active-file`, only the active path.
 * Under `workspace`, every non-excluded path. An explicit selection is user text:
 * it is included unless the exclusion list or workspace boundary rejects it.
 */
export function shouldInclude(path: string, kind: IncludeKind, policy: IncludePolicy): boolean {
  if (policy.includeCode === "off") return false;

  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");

  if (kind === "selection") {
    return normalized !== "" ? !isOutsideWorkspace(normalized) && !isExcludedPath(normalized) : true;
  }

  if (
    kind !== "active-file" &&
    kind !== "open-editor" &&
    kind !== "workspace" &&
    kind !== "diagnostic" &&
    kind !== "session"
  ) {
    return false;
  }

  if (normalized === "" || isOutsideWorkspace(normalized) || isExcludedPath(normalized)) return false;

  if (policy.includeCode === "active-file") {
    return normalized === policy.activePath?.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  return true;
}
