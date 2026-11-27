import { describe, expect, it } from "vitest";
import {
  CONSENT_VERSION,
  consentKey,
  parseConsent,
  parseIncludeCode,
  redact,
  shouldInclude,
  consentMessage,
  consentedIncludeCode,
  EXCLUDE_GLOB,
  rgExcludeIglobs,
  type ConsentRecord,
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

  it("preserves a pre-existing NUL character unchanged", () => {
    const text = "a\u0000b";
    const result = redact(text);
    expect(result.text).toBe("a\u0000b");
    expect(result.count).toBe(0);
  });

  it("leaves a pre-existing marker-like string untouched when nothing matched", () => {
    const text = "[ [preflight-redacted-1] ]";
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
  });

  it("preserves a pre-existing numbered marker literal next to a secret", () => {
    const text = "[ [preflight-redacted-1] ] use sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa";
    const result = redact(text);
    expect(result.count).toBe(1);
    expect(result.text).toContain("[ [preflight-redacted-1] ]");
    expect(result.text).not.toContain("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("preserves a pre-existing colliding marker literal while redacting a secret", () => {
    const text = "[ [preflight-redacted-0] ] then key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa";
    const result = redact(text);
    expect(result.count).toBe(1);
    expect(result.text).toContain("[ [preflight-redacted-0] ]");
    expect(result.text).not.toContain("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("shouldInclude", () => {
  const files: IncludePolicy = { includeCode: "prompt-files", promptFiles: ["src/app.ts", "src/lib.ts"] };
  const ws: IncludePolicy = { includeCode: "workspace" };
  const off: IncludePolicy = { includeCode: "off", promptFiles: ["src/app.ts"] };

  it("off returns false for every kind, including prompt-file", () => {
    for (const kind of ["prompt-file", "workspace", "diagnostic", "session"] as const) {
      expect(shouldInclude("src/app.ts", kind, off)).toBe(false);
    }
    expect(shouldInclude("", "prompt-file", off)).toBe(false);
  });

  it("prompt-files includes only referenced paths", () => {
    for (const kind of ["prompt-file", "workspace", "diagnostic", "session"] as const) {
      expect(shouldInclude("src/app.ts", kind, files)).toBe(true);
      expect(shouldInclude("src/lib.ts", kind, files)).toBe(true);
      expect(shouldInclude("src/other.ts", kind, files)).toBe(false);
    }
    expect(shouldInclude("src/app.ts", "workspace", { includeCode: "prompt-files" })).toBe(false);
  });

  it("workspace includes every non-excluded path", () => {
    expect(shouldInclude("src/app.ts", "workspace", ws)).toBe(true);
    expect(shouldInclude("src/other.ts", "prompt-file", ws)).toBe(true);
    expect(shouldInclude("src/app.ts", "session", ws)).toBe(true);
    expect(shouldInclude("docs/readme.md", "diagnostic", ws)).toBe(true);
    expect(shouldInclude("", "workspace", ws)).toBe(false);
  });

  it("excludes secret file names under both prompt-files and workspace", () => {
    for (const policy of [files, ws]) {
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

  it("excludes build directories even when referenced", () => {
    expect(shouldInclude("dist/app.js", "prompt-file", { includeCode: "prompt-files", promptFiles: ["dist/app.js"] })).toBe(false);
    expect(shouldInclude("build/notes.md", "workspace", ws)).toBe(false);
    expect(shouldInclude("venv/lib/x.py", "prompt-file", { includeCode: "workspace" })).toBe(false);
  });

  it("exclusion wins over an explicit reference", () => {
    expect(shouldInclude("credentials.json", "prompt-file", { includeCode: "prompt-files", promptFiles: ["credentials.json"] })).toBe(false);
    expect(shouldInclude(".env", "workspace", { includeCode: "workspace" })).toBe(false);
  });

  it("does not include an untitled or virtual file", () => {
    expect(shouldInclude("", "prompt-file", ws)).toBe(false);
    expect(shouldInclude("", "workspace", ws)).toBe(false);
    expect(shouldInclude("", "diagnostic", ws)).toBe(false);
  });

  it("rejects absolute paths and path traversal", () => {
    expect(shouldInclude("/etc/passwd", "workspace", ws)).toBe(false);
    expect(shouldInclude("/etc/passwd", "prompt-file", ws)).toBe(false);
    expect(shouldInclude("../secrets.env", "workspace", ws)).toBe(false);
    expect(shouldInclude("src/../../etc/passwd", "prompt-file", ws)).toBe(false);
  });

  it("rejects windows drive-letter paths", () => {
    for (const path of ["C:/Users/x/app.ts", "C:\\Users\\x\\app.ts"]) {
      expect(shouldInclude(path, "workspace", ws)).toBe(false);
      expect(shouldInclude(path, "prompt-file", ws)).toBe(false);
    }
  });

  it("normalizes windows separators and leading ./", () => {
    expect(shouldInclude("src\\app.ts", "prompt-file", files)).toBe(true);
    expect(shouldInclude("./src/app.ts", "prompt-file", files)).toBe(true);
    expect(shouldInclude(".\\credentials.json", "workspace", ws)).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(shouldInclude("src/app.ts", "history" as IncludeKind, ws)).toBe(false);
  });
});

describe("parseIncludeCode", () => {
  it("maps the legacy active-file value to prompt-files", () => {
    expect(parseIncludeCode("active-file")).toBe("prompt-files");
  });

  it("keeps the current values", () => {
    expect(parseIncludeCode("off")).toBe("off");
    expect(parseIncludeCode("prompt-files")).toBe("prompt-files");
    expect(parseIncludeCode("workspace")).toBe("workspace");
  });

  it("defaults an unknown value to off", () => {
    expect(parseIncludeCode("unknown")).toBe("off");
    expect(parseIncludeCode(undefined)).toBe("off");
  });
});

describe("consentMessage", () => {
  const message = consentMessage();

  it("discloses both provider data-handling URLs", () => {
    expect(message).toContain("https://code.claude.com/docs/en/data-usage");
    expect(message).toContain("https://openai.com/policies/privacy-policy/");
  });

  it("states that the draft and Q&A are always sent", () => {
    expect(message).toContain("draft");
    expect(message).toContain("Q&A");
  });

  it("states that code is gated and redacted", () => {
    expect(message).toContain("includeCode");
    expect(message.toLowerCase()).toContain("redact");
    expect(message.toLowerCase()).toContain("until");
  });

  it("discloses unencrypted local persistence and clearHistory", () => {
    expect(message).toContain("unencrypted");
    expect(message).toContain("globalStorageUri");
    expect(message).toContain("clearHistory");
  });

  it("discloses the opt-in study log that clearHistory keeps", () => {
    expect(message.toLowerCase()).toContain("study log");
    expect(message.toLowerCase()).toContain("opt-in");
  });
});

describe("EXCLUDE_GLOB", () => {
  it("covers dependencies, git metadata and build directories", () => {
    expect(EXCLUDE_GLOB).toContain("node_modules");
    expect(EXCLUDE_GLOB).toContain(".git");
    for (const dir of ["dist", "out", "build", ".venv", "venv", "__pycache__", ".next", "target"]) {
      expect(EXCLUDE_GLOB).toContain(dir);
    }
  });
});

describe("rgExcludeIglobs (#61)", () => {
  it("derives the rg exclusions from the same sets the policy checks", () => {
    expect(rgExcludeIglobs()).toEqual([
      "!**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,.next,target}",
      "!**/{credentials.json,id_rsa,id_ed25519,.env,.env.*,*.pem,*.key}",
    ]);
  });
});

describe("consentedIncludeCode", () => {
  const accepted: ConsentRecord = { version: 1, decision: "accepted", decidedAt: "2026-01-01T00:00:00.000Z" };
  const declined: ConsentRecord = { version: 1, decision: "declined", decidedAt: "2026-01-01T00:00:00.000Z" };

  it("returns the setting for each value when consent is accepted", () => {
    expect(consentedIncludeCode("off", accepted)).toBe("off");
    expect(consentedIncludeCode("prompt-files", accepted)).toBe("prompt-files");
    expect(consentedIncludeCode("workspace", accepted)).toBe("workspace");
  });

  it("returns off for declined consent", () => {
    expect(consentedIncludeCode("off", declined)).toBe("off");
    expect(consentedIncludeCode("prompt-files", declined)).toBe("off");
    expect(consentedIncludeCode("workspace", declined)).toBe("off");
  });

  it("returns off when no consent record exists", () => {
    expect(consentedIncludeCode("off", null)).toBe("off");
    expect(consentedIncludeCode("prompt-files", null)).toBe("off");
    expect(consentedIncludeCode("workspace", null)).toBe("off");
  });
});
