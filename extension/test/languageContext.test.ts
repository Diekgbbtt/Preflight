// Ticket #37: language context provider tests. No vscode import here.
import { describe, expect, it, vi } from "vitest";
import { gitChangedFiles, gitStatus, rg, type ExecFileLike } from "../src/exec";
import {
  buildDefinitionsFragment,
  buildDiagnosticsFragment,
  buildReferencesFragment,
  buildSymbolsFragment,
  buildWorkspaceSymbolsFragment,
  type LanguageDiagnostic,
  type LanguageLocation,
  type LanguageSymbol,
} from "../src/languageContext";

const at = (line: number, character: number) => ({ line, character });

const options = { cwd: "/repo", timeout: 5000, maxBuffer: 1024 * 1024 };

describe("gitStatus", () => {
  it("requests porcelain v1 with -z", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "", ""));
    await gitStatus("/repo", exec);
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v1", "-z"], options, expect.any(Function));
  });

  it("parses NUL-separated entries and keeps spaces in paths", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "M  a.ts\0?? my new file.ts\0", ""));
    const result = await gitStatus("/repo", exec);
    expect(result).toEqual({
      ok: true,
      entries: [
        { status: "M ", path: "a.ts" },
        { status: "??", path: "my new file.ts" },
      ],
      truncated: false,
    });
  });

  it("skips the original-path segment of a rename entry", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "R  renamed.ts\0old name.ts\0M  b.ts\0", ""));
    const result = await gitStatus("/repo", exec);
    expect(result).toEqual({
      ok: true,
      entries: [
        { status: "R ", path: "renamed.ts" },
        { status: "M ", path: "b.ts" },
      ],
      truncated: false,
    });
  });

  it("caps entries at MAX_GIT_ENTRIES and sets truncated", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `M f${i}.ts\0`).join("");
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, many, ""));
    const result = await gitStatus("/repo", exec);
    if (!result.ok) throw new Error("expected ok");
    expect(result.entries).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("returns the git failure with code and stderr", async () => {
    const error = Object.assign(new Error("git failed"), { code: 128 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", "fatal: not a git repository"));
    const result = await gitStatus("/repo", exec);
    expect(result).toEqual({ ok: false, code: undefined, stderr: "fatal: not a git repository" });
  });
});

describe("gitChangedFiles", () => {
  it("unions status paths with the last 5 commits' names, unique and sorted", async () => {
    const exec = vi.fn<ExecFileLike>((_c, args, _o, cb) => {
      if (args[0] === "status") cb(null, "M  b.ts\0?? a.ts\0", "");
      else cb(null, "c.ts\0a.ts\0", "");
    });
    const result = await gitChangedFiles("/repo", exec);
    if (!result.ok) throw new Error("expected ok");
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("requests the log with the name-only -z shape", async () => {
    const exec = vi.fn<ExecFileLike>((_c, args, _o, cb) => {
      if (args[0] === "status") cb(null, "", "");
      else cb(null, "", "");
    });
    await gitChangedFiles("/repo", exec);
    expect(exec).toHaveBeenCalledWith("git", ["log", "-n", "5", "--name-only", "--format=", "-z"], options, expect.any(Function));
  });

  it("keeps status paths when the log fails", async () => {
    const error = Object.assign(new Error("log failed"), { code: 128 });
    const exec = vi.fn<ExecFileLike>((_c, args, _o, cb) => {
      if (args[0] === "status") cb(null, "M  kept.ts\0", "");
      else cb(error, "", "fatal: bad object");
    });
    const result = await gitChangedFiles("/repo", exec);
    expect(result).toEqual({ ok: true, files: ["kept.ts"], truncated: false });
  });

  it("caps at MAX_GIT_ENTRIES and sets truncated", async () => {
    const statusNames = Array.from({ length: 150 }, (_, i) => `M  s${i}.ts\0`).join("");
    const logNames = Array.from({ length: 150 }, (_, i) => `l${i}.ts\0`).join("");
    const exec = vi.fn<ExecFileLike>((_c, args, _o, cb) => {
      if (args[0] === "status") cb(null, statusNames, "");
      else cb(null, logNames, "");
    });
    const result = await gitChangedFiles("/repo", exec);
    if (!result.ok) throw new Error("expected ok");
    expect(result.files).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("returns the git failure when status fails", async () => {
    const error = Object.assign(new Error("git failed"), { code: 128 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", "fatal: not a git repository"));
    const result = await gitChangedFiles("/repo", exec);
    expect(result).toEqual({ ok: false, code: undefined, stderr: "fatal: not a git repository" });
  });
});

describe("buildDiagnosticsFragment", () => {
  const diag = (path: string, line: number, message = "boom"): LanguageDiagnostic => ({
    uri: `file:///w/${path}`,
    path,
    range: { start: { line, character: 2 }, end: { line, character: 7 } },
    severity: "error",
    source: "tsc",
    message,
  });

  it("returns null for an empty list", () => {
    expect(buildDiagnosticsFragment([])).toBeNull();
  });

  it("builds one line per diagnostic with display positions", () => {
    const fragment = buildDiagnosticsFragment([diag("src/a.ts", 0), diag("src/b.ts", 4, "missing")]);
    expect(fragment).not.toBeNull();
    expect(fragment?.source).toBe("diagnostics");
    expect(fragment?.priority).toBe(45);
    expect(fragment?.content.split("\n")).toEqual([
      "error tsc src/a.ts:1:3-1:8 boom",
      "error tsc src/b.ts:5:3-5:8 missing",
    ]);
    expect(fragment?.tokens).toBe(Math.ceil((fragment?.content.length ?? 0) / 4));
    expect(fragment?.provenance).toEqual({
      kind: "diagnostic",
      truncated: false,
      chars: fragment?.content.length,
      folderUri: undefined,
    });
  });

  it("collapses newlines in the message", () => {
    const fragment = buildDiagnosticsFragment([diag("a.ts", 0, "line one\nline two\n  ")]);
    expect(fragment?.content).toBe("error tsc a.ts:1:3-1:8 line one line two");
  });

  it("caps at 200 and marks truncated", () => {
    const many = Array.from({ length: 201 }, (_, i) => diag(`f${i}.ts`, i));
    const fragment = buildDiagnosticsFragment(many);
    expect(fragment?.content.split("\n")).toHaveLength(200);
    expect(fragment?.provenance.truncated).toBe(true);
  });

  it("records the folder uri in provenance", () => {
    const fragment = buildDiagnosticsFragment([diag("a.ts", 0)], "file:///w");
    expect(fragment?.provenance.folderUri).toBe("file:///w");
  });
});

describe("buildSymbolsFragment", () => {
  const sym = (name: string, kind = "function", extra: Partial<LanguageSymbol> = {}): LanguageSymbol => ({
    name,
    kind,
    ...extra,
  });

  it("returns null for an empty list", () => {
    expect(buildSymbolsFragment([])).toBeNull();
  });

  it("renders kind and name with the container name", () => {
    const fragment = buildSymbolsFragment([
      sym("makeThing", "function"),
      sym("build", "method", { containerName: "Thing", uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(2, 0), end: at(9, 1) } }),
    ]);
    expect(fragment?.source).toBe("symbols");
    expect(fragment?.priority).toBe(40);
    expect(fragment?.content.split("\n")).toEqual(["function makeThing", "method Thing.build"]);
    expect(fragment?.provenance).toEqual({
      kind: "symbol",
      truncated: false,
      chars: fragment?.content.length,
      folderUri: undefined,
    });
  });

  it("sets provenance.path only when every symbol is in the same file", () => {
    const one = buildSymbolsFragment([sym("a", "class", { path: "src/a.ts" })]);
    expect(one?.provenance.path).toBe("src/a.ts");
    const mixed = buildSymbolsFragment([sym("a", "class", { path: "src/a.ts" }), sym("b", "class", { path: "src/b.ts" })]);
    expect(mixed?.provenance.path).toBeUndefined();
  });

  it("caps at 100 and marks truncated", () => {
    const many = Array.from({ length: 101 }, (_, i) => sym(`s${i}`));
    const fragment = buildSymbolsFragment(many);
    expect(fragment?.content.split("\n")).toHaveLength(100);
    expect(fragment?.provenance.truncated).toBe(true);
  });
});

describe("buildWorkspaceSymbolsFragment", () => {
  it("returns null for an empty list", () => {
    expect(buildWorkspaceSymbolsFragment([])).toBeNull();
  });

  it("renders path:line:col, kind and name without a provenance range", () => {
    const fragment = buildWorkspaceSymbolsFragment([
      { name: "Thing", kind: "class", uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(0, 0), end: at(3, 1) } },
      { name: "helper", kind: "function", uri: "file:///w/src/b.ts", path: "src/b.ts", range: { start: at(4, 2), end: at(6, 1) } },
    ]);
    expect(fragment?.source).toBe("workspace-symbols");
    expect(fragment?.priority).toBe(37);
    expect(fragment?.content.split("\n")).toEqual(["src/a.ts:1:1 class Thing", "src/b.ts:5:3 function helper"]);
    expect(fragment?.provenance).toEqual({ kind: "workspace-symbol", truncated: false, chars: fragment?.content.length, folderUri: undefined });
  });

  it("caps at 50 and marks truncated", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      name: `s${i}`,
      kind: "function",
      uri: `file:///w/f${i}.ts`,
      path: `f${i}.ts`,
      range: { start: at(0, 0), end: at(0, 1) },
    }));
    const fragment = buildWorkspaceSymbolsFragment(many);
    expect(fragment?.content.split("\n")).toHaveLength(50);
    expect(fragment?.provenance.truncated).toBe(true);
  });
});

describe("buildDefinitionsFragment", () => {
  const loc = (path: string, line: number, name?: string): LanguageLocation => ({
    uri: `file:///w/${path}`,
    path,
    range: { start: at(line, 0), end: at(line, 3) },
    ...(name !== undefined ? { name } : {}),
  });

  it("returns null for an empty list", () => {
    expect(buildDefinitionsFragment([])).toBeNull();
  });

  it("renders one line per location with an optional name and no provenance range", () => {
    const fragment = buildDefinitionsFragment([loc("src/a.ts", 9, "makeThing"), loc("src/b.ts", 2)]);
    expect(fragment?.source).toBe("definitions");
    expect(fragment?.priority).toBe(38);
    expect(fragment?.content.split("\n")).toEqual(["src/a.ts:10:1 makeThing", "src/b.ts:3:1"]);
    expect(fragment?.provenance).toEqual({ kind: "definition", truncated: false, chars: fragment?.content.length, folderUri: undefined });
  });

  it("caps at 20 and marks truncated", () => {
    const many = Array.from({ length: 21 }, (_, i) => loc(`f${i}.ts`, i));
    const fragment = buildDefinitionsFragment(many);
    expect(fragment?.content.split("\n")).toHaveLength(20);
    expect(fragment?.provenance.truncated).toBe(true);
  });
});

describe("buildReferencesFragment", () => {
  it("returns null for an empty list", () => {
    expect(buildReferencesFragment([])).toBeNull();
  });

  it("renders one line per location with cap 50 and truncation", () => {
    const loc = (path: string): LanguageLocation => ({
      uri: `file:///w/${path}`,
      path,
      range: { start: at(0, 0), end: at(0, 1) },
    });
    const many = Array.from({ length: 51 }, (_, i) => loc(`f${i}.ts`));
    const fragment = buildReferencesFragment(many);
    expect(fragment?.source).toBe("references");
    expect(fragment?.priority).toBe(39);
    expect(fragment?.content.split("\n")).toEqual([
      "f0.ts:1:1",
      "f1.ts:1:1",
      ...Array.from({ length: 48 }, (_, i) => `f${i + 2}.ts:1:1`),
    ]);
    expect(fragment?.content.split("\n")).toHaveLength(50);
    expect(fragment?.provenance.truncated).toBe(true);
    const single = buildReferencesFragment([loc("a.ts")]);
    expect(single?.content).toBe("a.ts:1:1");
  });
});

describe("rg", () => {
  it("passes rg, the args and the timeout options to the executor", async () => {
    const exec = vi.fn<ExecFileLike>((_command, _args, _options, callback) => callback(null, "out", ""));
    await rg(["--json", "pat"], "/repo", exec);
    expect(exec).toHaveBeenCalledWith("rg", ["--json", "pat"], options, expect.any(Function));
  });

  it("resolves success with stdout", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "out", ""));
    const result = await rg(["pat"], "/repo", exec);
    expect(result).toEqual({ ok: true, stdout: "out" });
  });

  it("treats exit code 1 with no matches as a successful empty result", async () => {
    const error = Object.assign(new Error("Command failed: rg pat"), { code: 1 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", ""));
    const result = await rg(["pat"], "/repo", exec);
    expect(result).toEqual({ ok: true, stdout: "" });
  });

  it("resolves a failure with the code and stderr", async () => {
    const error = Object.assign(new Error("rg failed"), { code: 2 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", "unrecognized flag"));
    const result = await rg(["pat"], "/repo", exec);
    expect(result).toEqual({ ok: false, code: undefined, stderr: "unrecognized flag" });
  });

  it("resolves a missing rg with the ENOENT code", async () => {
    const error = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", ""));
    const result = await rg(["pat"], "/repo", exec);
    expect(result).toEqual({ ok: false, code: "ENOENT", stderr: "spawn rg ENOENT" });
  });
});
