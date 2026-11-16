import { describe, expect, it } from "vitest";
import { CONSENT_VERSION, consentKey, parseConsent } from "../src/privacy";

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
