// Pure privacy policy and redaction for prompt Preflight.
// Must not import vscode: the policy is testable without a VS Code mock.

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
