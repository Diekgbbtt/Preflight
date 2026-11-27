// Pure privacy policy and redaction for prompt Preflight.
// Must not import vscode: the policy is testable without a VS Code mock.
import { randomUUID } from "node:crypto";
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

// Marker wrapped around each replaced span during the sequential pass. No
// SECRETS pattern can match it, and its leading space stops the
// password-assignment value part (`[^\s"']{6,}`) from re-matching it. The
// per-call nonce plus the counter keep every marker unique, so a pre-existing
// marker-like string in the input cannot collide with an inserted marker, and
// only markers actually inserted during the call are turned into `[redacted]`.
// A marker-like string in the input or a genuine NUL is preserved untouched.
const markerFor = (nonce: string, n: number) => `[ [preflight-redacted-${nonce}-${n}] ]`;

/**
 * Replaces every SECRETS match with `[redacted]` and reports how many were replaced.
 * Patterns are applied sequentially to the updated text with fresh regex clones,
 * so shared global regex state and cross-pattern double counting are impossible.
 * Every marker inserted during this call is replaced with `[redacted]` at the
 * end. Never logs the matches or the original text.
 */
export function redact(text: string): RedactionResult {
  let masked = text;
  let count = 0;
  const nonce = randomUUID();
  const markers: string[] = [];
  for (const pattern of SECRETS) {
    const re = new RegExp(pattern.source, pattern.flags);
    masked = masked.replace(re, () => {
      const marker = markerFor(nonce, count++);
      markers.push(marker);
      return marker;
    });
  }
  let text2 = masked;
  for (const marker of markers) text2 = text2.split(marker).join("[redacted]");
  return { text: text2, count };
}

/** How much code context may be included in a model call. */
export type IncludeCode = "off" | "prompt-files" | "workspace";

/** The kind of text a source would include. Only code-bearing kinds reach shouldInclude. */
export type IncludeKind = "prompt-file" | "workspace" | "diagnostic" | "session";

/** The current privacy policy: the setting plus the explicitly referenced files. */
export interface IncludePolicy {
  includeCode: IncludeCode;
  /** Workspace-relative POSIX paths explicitly referenced with @ in the draft. */
  promptFiles?: string[];
}

// Excluded names, matched case-insensitively. Secret-bearing file names by
// basename, plus dependency, git and build directories by segment, matching
// the EXCLUDE_GLOB disclosure for referenced files too.
const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
]);
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
export function isOutsideWorkspace(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").includes("..");
}

/** Normalizes a workspace-relative path for policy comparison. */
export function normalizePolicyPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Maps a stored setting to the current vocabulary. The legacy `active-file` value means prompt-files. */
export function parseIncludeCode(value: unknown): IncludeCode {
  if (value === "off" || value === "prompt-files" || value === "workspace") return value;
  if (value === "active-file") return "prompt-files";
  return "off";
}

/**
 * Decides whether a code source may enter the model call. Pure and testable.
 * `path` is a workspace-relative POSIX path, or "" for an untitled or virtual document.
 * Under `off`, every kind is excluded. Under `prompt-files`, only paths the
 * draft referenced with @ are included. Under `workspace`, every non-excluded
 * path is included. The exclusion list and workspace boundary always win.
 */
export function shouldInclude(path: string, kind: IncludeKind, policy: IncludePolicy): boolean {
  if (kind !== "prompt-file" && kind !== "workspace" && kind !== "diagnostic" && kind !== "session") return false;
  if (policy.includeCode === "off") return false;

  const normalized = normalizePolicyPath(path);
  if (normalized === "" || isOutsideWorkspace(normalized) || isExcludedPath(normalized)) return false;

  if (policy.includeCode === "workspace") return true;

  const referenced = new Set((policy.promptFiles ?? []).map(normalizePolicyPath));
  return referenced.has(normalized);
}

/** Anthropic's page on how Claude Code handles your data. */
export const CLAUDE_DATA_URL = "https://code.claude.com/docs/en/data-usage";

/** OpenAI's privacy policy, for when Codex is selected as provider (#10). */
export const CODEX_DATA_URL = "https://openai.com/policies/privacy-policy/";

/** The full first-use disclosure shown once before code can leave the machine. */
export function consentMessage(): string {
  return [
    "Prompt Preflight sends your draft and its Q&A answers to the selected model provider (Claude Code, or Codex once supported).",
    `Code excerpts, diagnostics and session code are sent only when promptPreflight.context.includeCode allows it, after secret redaction; code inclusion stays off until you accept this notice, and a dismissed notice leaves it off until you accept. Provider data handling: Claude: ${CLAUDE_DATA_URL} - Codex: ${CODEX_DATA_URL}.`,
    "Drafts, Q&A, reviews, session slices inside review records, and send records are stored unencrypted under context.globalStorageUri and stay on this machine; they leave it only inside a model request.",
    "promptPreflight.clearHistory deletes those stored records.",
    "The study log is opt-in, separate, and is not deleted by clearHistory.",
  ].join(" ");
}

/**
 * Effective includeCode after consent. Returns the setting only for an accepted
 * consent; declined consent or no record yet returns "off".
 *
 * Consumers (#36 assembler, #38 session slice) must pass this effective value
 * into IncludePolicy.includeCode, never the raw setting, so code inclusion is
 * gated on an accepted consent even before the setting itself is changed.
 */
export function consentedIncludeCode(setting: IncludeCode, consent: ConsentRecord | null): IncludeCode {
  return consent?.decision === "accepted" ? setting : "off";
}

/** Single glob for vscode.workspace.findFiles that skips dependency, git and build directories. */
export const EXCLUDE_GLOB = "**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,.next,target}/**";

/**
 * ripgrep --iglob exclusion patterns derived from the same sets the policy
 * checks, so the search never opens a file `shouldInclude` rejects in any
 * include mode. This is a derived representation of the sets above, not a
 * third hand-written copy of the exclusion knowledge. `--iglob` matches the
 * policy's case-insensitive comparison.
 */
export function rgExcludeIglobs(): string[] {
  const dirs = [...EXCLUDED_DIR_SEGMENTS].join(",");
  const names = [...EXCLUDED_BASENAMES, ".env", ".env.*", "*.pem", "*.key"].join(",");
  return [`!**/{${dirs}}`, `!**/{${names}}`];
}

/**
 * Required privacy fields for one context source entry in the #36 manifest.
 * #36 owns the manifest type and uses these field names.
 */
export interface SourcePrivacyFields {
  /** Final included excerpt size after redaction and truncation. */
  chars: number;
  /** Number of secret matches replaced during redaction. */
  redactions: number;
}
