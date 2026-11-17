import { describe, expect, it } from "vitest";
import type { SendRecord } from "@prompt-preflight/core";
import { hashPrompt } from "@prompt-preflight/core";
import {
  AMBIGUITY_WINDOW_MS,
  SESSION_AGE_WINDOW_MS,
  SEND_MATCH_WINDOW_MS,
  canonicalFolderUri,
  encodeClaudeProjectPath,
  locateSession,
  type SessionCandidate,
} from "../src/sessionLocator";

const FOLDER = "file:///Users/alice/proj";

const clock = { now: () => 1_000_000 };

const candidate = (over: Partial<SessionCandidate> = {}): SessionCandidate => ({
  sessionId: "s1",
  provider: "claude",
  folderUri: FOLDER,
  filePath: "/home/.claude/projects/-Users-alice-proj/s1.jsonl",
  mtimeMs: clock.now() - 1000,
  ...over,
});

describe("canonicalFolderUri", () => {
  it("stabilizes file URIs across trailing slashes and redundant escapes", () => {
    expect(canonicalFolderUri("file:///Users/alice/proj/")).toBe("file:///Users/alice/proj");
    expect(canonicalFolderUri("file:///Users/alice/proj")).toBe("file:///Users/alice/proj");
  });

  it("canonicalizes Windows drive and UNC file URIs", () => {
    expect(canonicalFolderUri("file:///C:/Users/Alice/Proj/")).toBe("file:///c:/Users/Alice/Proj");
    expect(canonicalFolderUri("file:///c:/Users/Alice/Proj")).toBe("file:///c:/Users/Alice/Proj");
    expect(canonicalFolderUri("file:///C:/")).toBe("file:///c:/");
    expect(canonicalFolderUri("file://server/share/proj/")).toBe("file://server/share/proj");
    expect(canonicalFolderUri("file://localhost/C:/Users/Alice/Proj")).toBe("file:///c:/Users/Alice/Proj");
  });

  it("returns non-file URIs unchanged", () => {
    expect(canonicalFolderUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });

  it("returns a malformed URI unchanged instead of throwing", () => {
    expect(canonicalFolderUri("file:///Users/%ZZ")).toBe("file:///Users/%ZZ");
  });
});

describe("encodeClaudeProjectPath", () => {
  it("encodes POSIX and Windows paths with the Claude sanitizer", () => {
    expect(encodeClaudeProjectPath("/Users/Alice/Proj")).toBe("-Users-Alice-Proj");
    expect(encodeClaudeProjectPath("C:\\Users\\Alice\\Proj")).toBe("C--Users-Alice-Proj");
    expect(encodeClaudeProjectPath("C:\\Users\\Alice\\My Proj")).toBe("C--Users-Alice-My-Proj");
    expect(encodeClaudeProjectPath("")).toBe("unknown");
  });
});

describe("locateSession", () => {
  it("exposes the documented windows", () => {
    expect(SEND_MATCH_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(SESSION_AGE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(AMBIGUITY_WINDOW_MS).toBe(2 * 60 * 1000);
  });

  it("returns none without candidates", () => {
    expect(locateSession({ folderUri: FOLDER, sends: [], candidates: [], clock })).toEqual({ kind: "none" });
  });

  it("path 1: sendId exact match wins over hash and recency", () => {
    const c1 = candidate({ sessionId: "s-linked" });
    const c2 = candidate({ sessionId: "s2", mtimeMs: clock.now() - 10 });
    const result = locateSession({
      sendId: "send-9",
      folderUri: FOLDER,
      promptHash: "hash-1",
      sends: [{ schemaVersion: 1, seq: 1, id: "send-9", ts: new Date(clock.now() - 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-linked", target: "terminal" }],
      candidates: [c2, c1],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: c1 });
  });

  it("path 1: sendId with a missing linked file returns none, never a different session", () => {
    const result = locateSession({
      sendId: "send-9",
      folderUri: FOLDER,
      promptHash: "hash-1",
      sends: [{ schemaVersion: 1, seq: 1, id: "send-9", ts: new Date(clock.now() - 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-gone", target: "terminal" }],
      candidates: [candidate({ sessionId: "s2", mtimeMs: clock.now() - 10 })],
      clock,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("folds send versions to the highest seq before matching", () => {
    const cOld = candidate({ sessionId: "s-old" });
    const cNew = candidate({ sessionId: "s-new", mtimeMs: clock.now() - 2000 });
    const result = locateSession({
      sendId: "send-9",
      folderUri: FOLDER,
      sends: [
        { schemaVersion: 1, seq: 1, id: "send-9", ts: new Date(clock.now() - 5000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "h", sessionId: "s-old", target: "terminal" },
        { schemaVersion: 1, seq: 2, id: "send-9", ts: new Date(clock.now() - 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "h", sessionId: "s-new", target: "terminal" },
      ],
      candidates: [cOld, cNew],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: cNew });
  });

  it("path 2: matches hash inside the 30-minute window", () => {
    const c = candidate({ sessionId: "s-hash" });
    const result = locateSession({
      folderUri: FOLDER,
      promptHash: hashPrompt("Run the tests"),
      sends: [{ schemaVersion: 1, seq: 1, id: "send-1", ts: new Date(clock.now() - 29 * 60 * 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "Run the tests", promptHash: hashPrompt("Run the tests"), sessionId: "s-hash", target: "terminal" }],
      candidates: [c],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: c });
  });

  it("path 2: a hash match outside 30 minutes falls through to recency", () => {
    const c = candidate({ sessionId: "s-recent", mtimeMs: clock.now() - 1000 });
    const result = locateSession({
      folderUri: FOLDER,
      promptHash: hashPrompt("Run the tests"),
      sends: [{ schemaVersion: 1, seq: 1, id: "send-1", ts: new Date(clock.now() - 31 * 60 * 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "Run the tests", promptHash: hashPrompt("Run the tests"), sessionId: "s-hash", target: "terminal" }],
      candidates: [c],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: c });
  });

  it("path 2: takes the latest match by ts then seq", () => {
    const c1 = candidate({ sessionId: "s-a" });
    const c2 = candidate({ sessionId: "s-b" });
    const result = locateSession({
      folderUri: FOLDER,
      promptHash: "hash-1",
      sends: [
        { schemaVersion: 1, seq: 1, id: "send-1", ts: new Date(clock.now() - 2000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-a", target: "terminal" },
        { schemaVersion: 1, seq: 2, id: "send-2", ts: new Date(clock.now() - 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-b", target: "terminal" },
      ],
      candidates: [c1, c2],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: c2 });
  });

  it("path 2: missing candidate file falls through to recency", () => {
    const c = candidate({ sessionId: "s-recent", mtimeMs: clock.now() - 1000 });
    const result = locateSession({
      folderUri: FOLDER,
      promptHash: "hash-1",
      sends: [{ schemaVersion: 1, seq: 1, id: "send-1", ts: new Date(clock.now() - 1000).toISOString(), draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-gone", target: "terminal" }],
      candidates: [c],
      clock,
    });
    expect(result).toEqual({ kind: "found", candidate: c });
  });

  it("path 3: resolves the most recent session within 24 hours", () => {
    const old = candidate({ sessionId: "s-old", mtimeMs: clock.now() - SESSION_AGE_WINDOW_MS - 1000 });
    const recent = candidate({ sessionId: "s-recent", mtimeMs: clock.now() - 1000 });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [old, recent], clock });
    expect(result).toEqual({ kind: "found", candidate: recent });
  });

  it("path 3: no session modified within 24 hours returns none", () => {
    const old = candidate({ sessionId: "s-old", mtimeMs: clock.now() - SESSION_AGE_WINDOW_MS - 1000 });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [old], clock });
    expect(result).toEqual({ kind: "none" });
  });

  it("path 3: two candidates within 2 minutes return ambiguous, sorted mtime desc then id asc", () => {
    const a = candidate({ sessionId: "a", mtimeMs: clock.now() - 60 * 1000 });
    const b = candidate({ sessionId: "b", mtimeMs: clock.now() - 30 * 1000 });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [a, b], clock });
    expect(result).toEqual({ kind: "ambiguous", candidates: [b, a] });
  });

  it("path 3: ambiguity ignores candidates further than 2 minutes from the latest", () => {
    const a = candidate({ sessionId: "a", mtimeMs: clock.now() - 5 * 60 * 1000 });
    const b = candidate({ sessionId: "b", mtimeMs: clock.now() - 30 * 1000 });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [a, b], clock });
    expect(result).toEqual({ kind: "found", candidate: b });
  });

  it("respects the folder URI across roots", () => {
    const other = candidate({ sessionId: "s-other", folderUri: "file:///Users/alice/other", mtimeMs: clock.now() - 10 });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [other], clock });
    expect(result).toEqual({ kind: "none" });
  });

  it("matches candidates regardless of raw URI spelling", () => {
    const c = candidate({ folderUri: "file:///Users/alice/proj/" });
    const result = locateSession({ folderUri: FOLDER, sends: [], candidates: [c], clock });
    expect(result).toEqual({ kind: "found", candidate: c });
  });

  it("handles clock skew between send ts and the clock", () => {
    const old = candidate({ sessionId: "s-hash", mtimeMs: clock.now() - SESSION_AGE_WINDOW_MS - 1000 });
    const skew = locateSession({
      folderUri: FOLDER,
      promptHash: "hash-1",
      sends: [{ schemaVersion: 1, seq: 1, id: "send-1", ts: "not-a-date", draftId: "d1", folderUri: FOLDER, text: "t", promptHash: "hash-1", sessionId: "s-hash", target: "terminal" }],
      candidates: [old],
      clock,
    });
    expect(skew).toEqual({ kind: "none" });
  });});
