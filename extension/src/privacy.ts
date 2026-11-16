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
