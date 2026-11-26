import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { debugLogFile, isDebugTraceFile, resolveDebugLogDir } from "../src/debug/path";

describe("debug log path", () => {
  it("uses the extension global storage by default", () => {
    expect(resolveDebugLogDir("/global", "")).toBe(path.join("/global", "debug"));
    expect(resolveDebugLogDir("/global", "   ")).toBe(path.join("/global", "debug"));
  });

  it("resolves a relative directory under the global storage", () => {
    expect(resolveDebugLogDir("/global", "logs")).toBe(path.resolve("/global", "logs"));
  });

  it("keeps an absolute directory", () => {
    expect(resolveDebugLogDir("/global", "/tmp/preflight-debug")).toBe("/tmp/preflight-debug");
  });

  it("names the current file and recognizes rotations", () => {
    expect(debugLogFile("/tmp/debug")).toBe(path.join("/tmp/debug", "llm-trace.jsonl"));
    expect(isDebugTraceFile("llm-trace.jsonl")).toBe(true);
    expect(isDebugTraceFile("llm-trace.1.jsonl")).toBe(true);
    expect(isDebugTraceFile(".llm-trace.history")).toBe(true);
    expect(isDebugTraceFile("llm-trace.log")).toBe(false);
    expect(isDebugTraceFile("other.jsonl")).toBe(false);
  });

  it("resolves Windows paths with path.win32", () => {
    expect(resolveDebugLogDir("C:\\Users\\alice\\globalStorage", "", path.win32)).toBe(
      "C:\\Users\\alice\\globalStorage\\debug",
    );
    expect(resolveDebugLogDir("C:\\Users\\alice\\globalStorage", "logs", path.win32)).toBe(
      path.win32.resolve("C:\\Users\\alice\\globalStorage", "logs"),
    );
    expect(resolveDebugLogDir("C:\\Users\\alice\\globalStorage", "D:\\debug", path.win32)).toBe(
      "D:\\debug",
    );
    expect(debugLogFile("C:\\debug", path.win32)).toBe("C:\\debug\\llm-trace.jsonl");
  });
});
