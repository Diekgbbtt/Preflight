import { describe, expect, it } from "vitest";
import {
  CONSENT_VERSION,
  consentKey,
  parseConsent,
  redact,
  shouldInclude,
  type IncludeKind,
  type IncludePolicy,
} from "../src/privacy";

describe("consentKey", () => {
  it("returns the versioned global-state key", () => {
    expect(CONSENT_VERSION).toBe(1);
    expect(consentKey(1)).toBe("promptPreflight.consent.v1");
    expect(consentKey(2)).toBe("promptPreflight.consent.v2");
  });
});

describe("parseConsent", () => {
  it("accepts a current-version record", () => {
    const record = { version: 1, decision: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" };
    expect(parseConsent(record)).toEqual(record);
    expect(parseConsent({ version: 1, decision: "declined", decidedAt: "2026-01-01T00:00:00.000Z" })?.decision).toBe(
      "declined",
    );
  });

  it("rejects an older or future version", () => {
    expect(parseConsent({ version: 0, decision: "accepted", decidedAt: "2025-01-01T00:00:00.000Z" })).toBeNull();
    expect(parseConsent({ version: 2, decision: "accepted", decidedAt: "2027-01-01T00:00:00.000Z" })).toBeNull();
  });

  it("rejects malformed records without throwing", () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent(undefined)).toBeNull();
    expect(parseConsent("accepted")).toBeNull();
    expect(parseConsent(42)).toBeNull();
    expect(parseConsent([])).toBeNull();
    expect(parseConsent({})).toBeNull();
    expect(parseConsent({ version: 1, decision: "accepted" })).toBeNull();
    expect(parseConsent({ version: 1, decidedAt: "2026-01-01T00:00:00.000Z" })).toBeNull();
    expect(parseConsent({ version: 1, decision: "maybe", decidedAt: "2026-01-01T00:00:00.000Z" })).toBeNull();
    expect(parseConsent({ version: 1, decision: "accepted", decidedAt: 5 })).toBeNull();
  });
});

describe("redact", () => {
  it("redacts a single secret and counts one replacement", () => {
    const text = "use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa for the call";
    const result = redact(text);
    expect(result.text).toBe("use [redacted] for the call");
    expect(result.count).toBe(1);
  });

  it("redacts multiple secrets and counts each", () => {
    const text = "AKIAIOSFODNN7EXAMPLE and xoxb-123456789012345678 here";
    const result = redact(text);
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("xoxb-123456789012345678");
    expect(result.count).toBe(2);
  });

  it("redacts a password assignment containing an sk- token without double counting", () => {
    const text = 'password = "sk-abcdefghijklmnopqrstuvwx"';
    const result = redact(text);
    // The sk- pattern runs first; the assignment pattern then sees only the sentinel.
    expect(result.text).toBe('password = "[redacted]"');
    expect(result.count).toBe(1);
  });

  it("redacts the private-key header; the body remains (#23 gap)", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    const result = redact(text);
    expect(result.text).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(result.text).toContain("MIIB");
    expect(result.count).toBe(1);
  });

  it("leaves a file with no secrets unchanged and counts zero", () => {
    const text = "Fix the date bug in src/utils/date.ts so that tests pass";
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
  });

  it("redacts a placeholder that looks like a secret", () => {
    const result = redact("key: sk-placeholder-value-1234567890");
    expect(result.count).toBe(1);
    expect(result.text).not.toContain("sk-placeholder-value-1234567890");
  });

  it("keeps surrounding unicode text unchanged", () => {
    const text = "密钥 → sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa ← 请勿外传";
    const result = redact(text);
    expect(result.text).toBe("密钥 → [redacted] ← 请勿外传");
    expect(result.count).toBe(1);
  });

  it("cannot redact a secret split across lines (#23 gap)", () => {
    const result = redact("sk-abc\ndefghijklmnopqrs");
    expect(result.count).toBe(0);
  });

  it("redacts on repeated calls despite shared global regex state", () => {
    const text = "token sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa end";
    const first = redact(text);
    const second = redact(text);
    expect(first.count).toBe(1);
    expect(second.count).toBe(1);
    expect(second.text).toBe(first.text);
  });

  it("redacts gh and github_pat tokens", () => {
    const text = "ghp_abcdefghijklmnopqrstuvwxyz123456 github_pat_AAAA0123456789abcdefghij0123456789";
    const result = redact(text);
    expect(result.count).toBe(2);
    expect(result.text).not.toContain("ghp_");
    expect(result.text).not.toContain("github_pat_");
  });
});

describe("shouldInclude", () => {
  const active: IncludePolicy = { includeCode: "active-file", activePath: "src/app.ts" };
  const ws: IncludePolicy = { includeCode: "workspace" };
  const off: IncludePolicy = { includeCode: "off", activePath: "src/app.ts" };

  it("off returns false for every kind, including selection", () => {
    expect(shouldInclude("src/app.ts", "workspace", off)).toBe(false);
    expect(shouldInclude("src/app.ts", "active-file", off)).toBe(false);
    expect(shouldInclude("src/app.ts", "open-editor", off)).toBe(false);
    expect(shouldInclude("src/app.ts", "diagnostic", off)).toBe(false);
    expect(shouldInclude("src/app.ts", "session", off)).toBe(false);
    expect(shouldInclude("src/app.ts", "selection", off)).toBe(false);
    expect(shouldInclude("", "selection", off)).toBe(false);
  });

  it("active-file includes only the active path", () => {
    expect(shouldInclude("src/app.ts", "workspace", active)).toBe(true);
    expect(shouldInclude("src/app.ts", "open-editor", active)).toBe(true);
    expect(shouldInclude("src/app.ts", "diagnostic", active)).toBe(true);
    expect(shouldInclude("src/app.ts", "session", active)).toBe(true);
    expect(shouldInclude("src/other.ts", "workspace", active)).toBe(false);
    expect(shouldInclude("src/other.ts", "diagnostic", active)).toBe(false);
    expect(shouldInclude("", "workspace", active)).toBe(false);
    expect(shouldInclude("src/app.ts", "workspace", { includeCode: "active-file" })).toBe(false);
  });

  it("active-file includes an explicit selection even outside the active path", () => {
    expect(shouldInclude("src/other.ts", "selection", active)).toBe(true);
    expect(shouldInclude("", "selection", active)).toBe(true);
  });

  it("workspace includes every non-excluded path", () => {
    expect(shouldInclude("src/app.ts", "workspace", ws)).toBe(true);
    expect(shouldInclude("docs/readme.md", "diagnostic", ws)).toBe(true);
    expect(shouldInclude("", "workspace", ws)).toBe(false);
  });

  it("excludes secret file names under both active-file and workspace", () => {
    for (const policy of [active, ws]) {
      for (const path of [
        ".env",
        ".env.local",
        "credentials.json",
        "id_rsa",
        "id_ed25519",
        "foo.pem",
        "foo.KEY",
        "node_modules/x.ts",
        ".git/config",
        "src/credentials.json",
      ]) {
        expect(shouldInclude(path, "workspace", policy)).toBe(false);
      }
    }
  });

  it("exclusion wins over an explicit selection", () => {
    expect(shouldInclude("credentials.json", "selection", active)).toBe(false);
    expect(shouldInclude(".env", "selection", ws)).toBe(false);
  });

  it("includes an untitled or virtual selection, but not untitled workspace kinds", () => {
    expect(shouldInclude("", "selection", ws)).toBe(true);
    expect(shouldInclude("", "active-file", ws)).toBe(false);
    expect(shouldInclude("", "open-editor", ws)).toBe(false);
    expect(shouldInclude("", "diagnostic", ws)).toBe(false);
  });

  it("rejects absolute paths and path traversal", () => {
    expect(shouldInclude("/etc/passwd", "workspace", ws)).toBe(false);
    expect(shouldInclude("/etc/passwd", "selection", ws)).toBe(false);
    expect(shouldInclude("../secrets.env", "workspace", ws)).toBe(false);
    expect(shouldInclude("src/../../etc/passwd", "selection", ws)).toBe(false);
  });

  it("normalizes windows separators and leading ./", () => {
    expect(shouldInclude("src\\app.ts", "workspace", active)).toBe(true);
    expect(shouldInclude("./src/app.ts", "workspace", active)).toBe(true);
    expect(shouldInclude(".\\credentials.json", "workspace", ws)).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(shouldInclude("src/app.ts", "history" as IncludeKind, ws)).toBe(false);
  });
});
