// Ticket #37: language context provider tests. No vscode import here.
import { describe, expect, it, vi } from "vitest";
import { gitChangedFiles, gitStatus, rg, type ExecFileLike } from "../src/exec";
import {
  buildDefinitionsFragment,
  buildDiagnosticsFragment,
  buildReferencesFragment,
  buildSymbolsFragment,
  buildWorkspaceSymbolsFragment,
  probeCapabilities,
  searchFallback,
  withTimeout,
  createDiagnosticsSource,
  createDefinitionsSource,
  createLanguageSources,
  createReferencesSource,
  createSymbolsSource,
  createWorkspaceSymbolsSource,
  type LanguageApi,
  type LanguageDiagnostic,
  type LanguageLocation,
  type LanguageSourceDeps,
  type LanguageSymbol,
  type TextSearchMatch,
  type TextSearchOptions,
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

  it("renders kind and name with the container name, and a location when path and range exist", () => {
    const fragment = buildSymbolsFragment([
      sym("makeThing", "function"),
      sym("build", "method", { containerName: "Thing", uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(2, 0), end: at(9, 1) } }),
    ]);
    expect(fragment?.source).toBe("symbols");
    expect(fragment?.priority).toBe(40);
    expect(fragment?.content.split("\n")).toEqual(["function makeThing", "src/a.ts:3:1 method Thing.build"]);
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

describe("withTimeout", () => {
  it("resolves with the underlying value when it arrives in time", async () => {
    await expect(withTimeout(Promise.resolve("v"), 50)).resolves.toBe("v");
  });

  it("rejects with a timeout error after ms", async () => {
    await expect(withTimeout(new Promise<string>(() => {}), 10)).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects with code cancelled on abort and clears the timer", async () => {
    const controller = new AbortController();
    const pending = withTimeout(new Promise<string>(() => {}), 10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withTimeout(Promise.resolve("v"), 50, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  it("propagates the underlying rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("provider boom")), 50)).rejects.toThrow("provider boom");
  });

  it("removes the abort listener and clears the timer on resolve", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await expect(withTimeout(Promise.resolve("v"), 10_000, controller.signal)).resolves.toBe("v");
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the abort listener and clears the timer on timeout", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    await expect(withTimeout(new Promise<string>(() => {}), 10, controller.signal)).rejects.toMatchObject({ code: "timeout" });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the abort listener when the abort itself settles the call", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const pending = withTimeout(new Promise<string>(() => {}), 10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("probeCapabilities", () => {
  const okApi = (): LanguageApi => ({
    documentSymbols: async () => [{ name: "s", kind: "function" }],
    workspaceSymbols: async () => [{ name: "w", kind: "function" }],
    definitions: async () => [{ uri: "file:///w/a.ts", range: { start: at(0, 0), end: at(0, 1) } }],
    references: async () => [],
    diagnostics: async () => [],
    textSearch: async () => [],
  });

  it("returns null for an empty uri", async () => {
    await expect(probeCapabilities(okApi(), "")).resolves.toBeNull();
  });

  it("turns each provider result into a boolean and discards the lists", async () => {
    const api = okApi();
    const spy = vi.spyOn(api, "documentSymbols");
    await expect(probeCapabilities(api, "file:///w/a.ts")).resolves.toEqual({
      documentSymbols: true,
      workspaceSymbols: true,
      definitions: true,
      references: true,
      diagnostics: true,
    });
    expect(spy).toHaveReturnedTimes(1);
  });

  it("marks a provider false when it throws or hangs past the timeout", async () => {
    const api: LanguageApi = {
      ...okApi(),
      documentSymbols: () => new Promise(() => {}),
      references: async () => {
        throw new Error("boom");
      },
    };
    const capabilities = await probeCapabilities(api, "file:///w/a.ts", 20);
    expect(capabilities).toEqual({
      documentSymbols: false,
      workspaceSymbols: true,
      definitions: true,
      references: false,
      diagnostics: true,
    });
  });

  it("marks a provider false when it throws synchronously instead of escaping", async () => {
    const api: LanguageApi = {
      ...okApi(),
      documentSymbols: () => {
        throw new Error("sync boom");
      },
    };
    await expect(probeCapabilities(api, "file:///w/a.ts")).resolves.toEqual({
      documentSymbols: false,
      workspaceSymbols: true,
      definitions: true,
      references: true,
      diagnostics: true,
    });
  });

  it("threads the signal so an abort rejects the whole probe", async () => {
    const controller = new AbortController();
    const api: LanguageApi = {
      ...okApi(),
      documentSymbols: () =>
        new Promise(() => {
          controller.signal.addEventListener("abort", () => {
            throw Object.assign(new Error("cancelled"), { code: "cancelled" });
          });
        }),
    };
    controller.abort();
    await expect(probeCapabilities(api, "file:///w/a.ts", 10_000, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("searchFallback", () => {
  const match = (path: string, line = 0, preview = "let x"): TextSearchMatch => ({
    uri: `file:///w/${path}`,
    path,
    range: { start: at(line, 3), end: at(line, 7) },
    preview,
  });
  const apiWith = (matches: TextSearchMatch[], calls?: { query?: string; options?: TextSearchOptions }[]): LanguageApi => ({
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    definitions: async () => [],
    references: async () => [],
    diagnostics: async () => [],
    textSearch: async (query, options) => {
      calls?.push({ query, options });
      return matches;
    },
  });
  const options = {
    sourceId: "symbols" as const,
    priority: 40,
    cwd: "/w",
    folderUri: "file:///w",
  };

  it("returns null for an empty or whitespace query", async () => {
    await expect(searchFallback(apiWith([match("a.ts")]), "  ", options)).resolves.toBeNull();
  });

  it("builds a text-search fragment with the source id and priority from the options", async () => {
    const fragment = await searchFallback(apiWith([match("src/a.ts", 4, "makeThing() {")]), "makeThing", options);
    expect(fragment?.source).toBe("symbols");
    expect(fragment?.priority).toBe(40);
    expect(fragment?.content).toBe("src/a.ts:5:4 makeThing() {");
    expect(fragment?.provenance.kind).toBe("text-search");
    expect(fragment?.provenance.truncated).toBe(false);
  });

  it("caps at 50 matches and marks truncated", async () => {
    const matches = Array.from({ length: 60 }, (_, i) => match(`f${i}.ts`, i));
    const fragment = await searchFallback(apiWith(matches), "pat", options);
    expect(fragment?.content.split("\n")).toHaveLength(50);
    expect(fragment?.provenance.truncated).toBe(true);
  });

  it("clamps an overriding maxResults to the 50-match cap", async () => {
    const matches = Array.from({ length: 60 }, (_, i) => match(`f${i}.ts`, i));
    const fragment = await searchFallback(apiWith(matches), "pat", { ...options, maxResults: 60 });
    expect(fragment?.content.split("\n")).toHaveLength(50);
    expect(fragment?.provenance.truncated).toBe(true);
  });

  it("passes maxResults to the text search and defaults to 50", async () => {
    const calls: Array<{ query?: string; options?: TextSearchOptions }> = [];
    await searchFallback(apiWith([], calls), "pat", options);
    expect(calls[0]?.query).toBe("pat");
    expect(calls[0]?.options).toEqual({ cwd: "/w", maxResults: 50 });
    await searchFallback(apiWith([], calls), "pat", { ...options, maxResults: 10 });
    expect(calls[1]?.options).toEqual({ cwd: "/w", maxResults: 10 });
  });

  it("returns null when every match is outside the workspace", async () => {
    const fragment = await searchFallback(apiWith([match("/etc/passwd"), match("../outside.ts")]), "pat", options);
    expect(fragment).toBeNull();
  });

  it("filters matches with allowPath", async () => {
    const fragment = await searchFallback(apiWith([match("secret.env"), match("a.ts")]), "pat", {
      ...options,
      allowPath: (path) => path === "a.ts",
    });
    expect(fragment?.content).toBe("a.ts:1:4 let x");
  });

  it("returns null with no matches", async () => {
    await expect(searchFallback(apiWith([]), "pat", options)).resolves.toBeNull();
  });

  it("rethrows an ENOENT failure with code ENOENT", async () => {
    const api: LanguageApi = {
      documentSymbols: async () => [],
      workspaceSymbols: async () => [],
      definitions: async () => [],
      references: async () => [],
      diagnostics: async () => [],
      textSearch: async () => {
        throw Object.assign(new Error("rg is missing"), { code: "ENOENT" });
      },
    };
    await expect(searchFallback(api, "pat", options)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws the cancelled error on abort", async () => {
    const controller = new AbortController();
    const api: LanguageApi = {
      documentSymbols: async () => [],
      workspaceSymbols: async () => [],
      definitions: async () => [],
      references: async () => [],
      diagnostics: async () => [],
      textSearch: () =>
        new Promise<TextSearchMatch[]>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true });
        }),
    };
    controller.abort();
    await expect(searchFallback(api, "pat", options, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("createDiagnosticsSource", () => {
  const diag = (path: string, message = "boom"): LanguageDiagnostic => ({
    uri: `file:///w/${path}`,
    path,
    range: { start: at(0, 0), end: at(0, 1) },
    severity: "error",
    source: "tsc",
    message,
  });
  const baseApi = (diagnostics: LanguageDiagnostic[] = [diag("a.ts")]): LanguageApi => ({
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    definitions: async () => [],
    references: async () => [],
    diagnostics: async () => diagnostics,
    textSearch: async () => [],
  });
  const caps = { documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true };
  const deps = (over: Partial<LanguageSourceDeps> & { api?: LanguageApi } = {}): LanguageSourceDeps => ({
    api: over.api ?? baseApi(),
    policy: { includeCode: "workspace" },
    folderUri: "file:///w",
    ...over,
  });

  it("has the diagnostics source id and priority", () => {
    const source = createDiagnosticsSource(deps());
    expect(source.id).toBe("diagnostics");
    expect(source.priority).toBe(45);
  });

  it("omits with empty when there are no open documents", async () => {
    const result = await createDiagnosticsSource(deps()).collect();
    expect(result.fragments).toEqual([]);
    expect(result.omittedReason).toBe("empty");
  });

  it("collects diagnostics for included open documents with details", async () => {
    const api = baseApi([diag("a.ts", "one"), diag("a.ts", "two")]);
    const result = await createDiagnosticsSource(deps({ api, openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] })).collect();
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.content.split("\n")).toEqual([
      "error tsc a.ts:1:1-1:2 one",
      "error tsc a.ts:1:1-1:2 two",
    ]);
    expect(result.details).toEqual({ files: 1, count: 2, dropped: 0 });
  });

  it("skips excluded documents and omits with excluded when all are filtered", async () => {
    const api = baseApi();
    const result = await createDiagnosticsSource(
      deps({ api, openDocuments: [{ uri: "file:///w/n/x.ts", path: "node_modules/n/x.ts" }] }),
    ).collect();
    expect(result.omittedReason).toBe("excluded");
  });

  it("counts open documents rejected by shouldInclude in the dropped detail", async () => {
    const api = baseApi([diag("a.ts", "one")]);
    const result = await createDiagnosticsSource(
      deps({
        api,
        openDocuments: [
          { uri: "file:///w/a.ts", path: "a.ts" },
          { uri: "file:///w/n/x.ts", path: "node_modules/n/x.ts" },
        ],
      }),
    ).collect();
    expect(result.details).toEqual({ files: 1, count: 1, dropped: 1 });
  });

  it("omits with unsupported when the probe is null or diagnostics is false", async () => {
    const probe = async () => null;
    const result = await createDiagnosticsSource(deps({ probe, openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] })).collect();
    expect(result.omittedReason).toBe("unsupported");
    const probeFalse = async () => ({ ...caps, diagnostics: false });
    const result2 = await createDiagnosticsSource(deps({ probe: probeFalse, openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] })).collect();
    expect(result2.omittedReason).toBe("unsupported");
  });

  it("omits with empty when the file has no diagnostics", async () => {
    const result = await createDiagnosticsSource(
      deps({ api: baseApi([]), openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] }),
    ).collect();
    expect(result.omittedReason).toBe("empty");
  });

  it("caps at 200 diagnostics and marks truncated with the capped count", async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => diag(`f${i % 3}.ts`, `m${i}`));
    const result = await createDiagnosticsSource(
      deps({ api: baseApi(many), openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }, { uri: "file:///w/b.ts", path: "b.ts" }, { uri: "file:///w/c.ts", path: "c.ts" }] }),
    ).collect();
    expect(result.fragments[0]?.content.split("\n")).toHaveLength(200);
    expect(result.fragments[0]?.provenance.truncated).toBe(true);
    expect(result.details).toEqual({ files: 3, count: 200, dropped: 0 });
  });

  it("omits with error when the provider throws", async () => {
    const api = deps({ openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] }).api as LanguageApi;
    const throwing: LanguageApi = { ...api, diagnostics: async () => { throw new Error("boom"); } };
    const result = await createDiagnosticsSource(deps({ api: throwing, openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] })).collect();
    expect(result.omittedReason).toBe("error");
  });

  it("throws the cancelled error when the signal is aborted", async () => {
    const controller = new AbortController();
    const api = baseApi();
    (api as { diagnostics: (uri: string) => Promise<LanguageDiagnostic[]> }).diagnostics = () =>
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true });
      });
    controller.abort();
    await expect(createDiagnosticsSource(deps({ api, openDocuments: [{ uri: "file:///w/a.ts", path: "a.ts" }] })).collect(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("createSymbolsSource", () => {
  const sym = (name: string, path?: string): LanguageSymbol => ({
    name,
    kind: "function",
    ...(path !== undefined ? { uri: `file:///w/${path}`, path, range: { start: at(0, 0), end: at(0, 1) } } : {}),
  });
  const caps = { documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true };
  const baseApi = (symbols: LanguageSymbol[] = [sym("makeThing", "src/a.ts")]): LanguageApi => ({
    documentSymbols: async () => symbols,
    workspaceSymbols: async () => [],
    definitions: async () => [],
    references: async () => [],
    diagnostics: async () => [],
    textSearch: async (query) => [
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(3, 0), end: at(3, 1) }, preview: query },
    ],
  });
  const deps = (over: Partial<LanguageSourceDeps> & { api?: LanguageApi } = {}): LanguageSourceDeps => ({
    api: over.api ?? baseApi(),
    policy: { includeCode: "workspace" },
    folderUri: "file:///w",
    cwd: "/w",
    activeUri: "file:///w/src/a.ts",
    activePath: "src/a.ts",
    activePosition: { line: 4, character: 6 },
    ...over,
  });

  it("has the symbols source id and priority", () => {
    const source = createSymbolsSource(deps());
    expect(source.id).toBe("symbols");
    expect(source.priority).toBe(40);
  });

  it("omits with empty when there is no active uri or path", async () => {
    expect((await createSymbolsSource(deps({ activeUri: undefined })).collect()).omittedReason).toBe("empty");
    expect((await createSymbolsSource(deps({ activePath: undefined })).collect()).omittedReason).toBe("empty");
  });

  it("omits with excluded when the active path fails shouldInclude", async () => {
    const result = await createSymbolsSource(deps({ activePath: "node_modules/n/x.ts" })).collect();
    expect(result.omittedReason).toBe("excluded");
  });

  it("collects document symbols with details", async () => {
    const result = await createSymbolsSource(deps()).collect();
    expect(result.fragments[0]?.source).toBe("symbols");
    expect(result.fragments[0]?.content).toBe("src/a.ts:1:1 function makeThing");
    expect(result.details).toEqual({ count: 1, dropped: 0 });
  });

  it("falls back to text search when the probe says no document symbols", async () => {
    const probe = async () => ({ ...caps, documentSymbols: false });
    const result = await createSymbolsSource(deps({ probe, query: "makeThing" })).collect();
    expect(result.fragments[0]?.source).toBe("symbols");
    expect(result.fragments[0]?.provenance.kind).toBe("text-search");
    expect(result.details).toEqual({ count: 1, textSearch: true, dropped: 0 });
  });

  it("omits with unsupported when the probe fails and no query exists", async () => {
    const probe = async () => null;
    expect((await createSymbolsSource(deps({ probe })).collect()).omittedReason).toBe("unsupported");
  });

  it("omits with empty when the provider returns no symbols and no query exists", async () => {
    expect((await createSymbolsSource(deps({ api: baseApi([]) })).collect()).omittedReason).toBe("empty");
  });

  it("caps at 100 and marks truncated", async () => {
    const many = Array.from({ length: 101 }, (_, i) => sym(`s${i}`, "src/a.ts"));
    const result = await createSymbolsSource(deps({ api: baseApi(many) })).collect();
    expect(result.fragments[0]?.content.split("\n")).toHaveLength(100);
    expect(result.fragments[0]?.provenance.truncated).toBe(true);
    expect(result.details).toEqual({ count: 100, dropped: 0 });
  });

  it("omits with error when the provider throws", async () => {
    const api: LanguageApi = { ...baseApi(), documentSymbols: async () => { throw new Error("boom"); } };
    expect((await createSymbolsSource(deps({ api })).collect()).omittedReason).toBe("error");
  });

  it("uses the text-search fallback with empty provider output and a query", async () => {
    const result = await createSymbolsSource(deps({ api: baseApi([]), query: "makeThing" })).collect();
    expect(result.fragments[0]?.provenance.kind).toBe("text-search");
    expect(result.details).toEqual({ count: 1, textSearch: true, dropped: 0 });
  });
  it("omits with unsupported when the fallback reports a missing rg", async () => {
    const probe = async () => ({ ...caps, documentSymbols: false });
    const api: LanguageApi = {
      ...baseApi([]),
      textSearch: async () => {
        throw Object.assign(new Error("rg is not available"), { code: "ENOENT" });
      },
    };
    const result = await createSymbolsSource(deps({ api, probe, query: "makeThing" })).collect();
    expect(result.omittedReason).toBe("unsupported");
    expect(result.fragments).toEqual([]);
  });

  it("omits with error when the fallback fails for another reason", async () => {
    const probe = async () => ({ ...caps, documentSymbols: false });
    const api: LanguageApi = {
      ...baseApi([]),
      textSearch: async () => {
        throw new Error("rg exploded");
      },
    };
    const result = await createSymbolsSource(deps({ api, probe, query: "makeThing" })).collect();
    expect(result.omittedReason).toBe("error");
  });
});

describe("createWorkspaceSymbolsSource", () => {
  const caps = { documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true };
  const wsSym = (name: string, path?: string): LanguageSymbol => ({
    name,
    kind: "class",
    ...(path !== undefined ? { uri: `file:///w/${path}`, path, range: { start: at(0, 0), end: at(0, 1) } } : {}),
  });
  const baseApi = (symbols: LanguageSymbol[] = [wsSym("Thing", "src/a.ts")]): LanguageApi => ({
    documentSymbols: async () => [],
    workspaceSymbols: async () => symbols,
    definitions: async () => [],
    references: async () => [],
    diagnostics: async () => [],
    textSearch: async () => [{ uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(0, 0), end: at(0, 1) }, preview: "class Thing" }],
  });
  const deps = (over: Partial<LanguageSourceDeps> & { api?: LanguageApi } = {}): LanguageSourceDeps => ({
    api: over.api ?? baseApi(),
    policy: { includeCode: "workspace" },
    folderUri: "file:///w",
    cwd: "/w",
    query: "Thing",
    ...over,
  });

  it("has the workspace-symbols source id and priority", () => {
    const source = createWorkspaceSymbolsSource(deps());
    expect(source.id).toBe("workspace-symbols");
    expect(source.priority).toBe(37);
  });

  it("omits with empty when the query is missing or blank, without calling the provider", async () => {
    let called = false;
    const api: LanguageApi = { ...baseApi(), workspaceSymbols: async () => { called = true; return []; } };
    expect((await createWorkspaceSymbolsSource(deps({ api, query: undefined })).collect()).omittedReason).toBe("empty");
    expect((await createWorkspaceSymbolsSource(deps({ api, query: "  " })).collect()).omittedReason).toBe("empty");
    expect(called).toBe(false);
  });

  it("collects workspace symbols with details", async () => {
    const result = await createWorkspaceSymbolsSource(deps()).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:1:1 class Thing");
    expect(result.details).toEqual({ count: 1, dropped: 0 });
  });

  it("drops pathless symbols and filters excluded paths", async () => {
    const api = baseApi([wsSym("Thing", "src/a.ts"), wsSym("Orphan"), wsSym("Secret", "credentials.json")]);
    const result = await createWorkspaceSymbolsSource(deps({ api })).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:1:1 class Thing");
    expect(result.details).toEqual({ count: 1, dropped: 2 });
  });

  it("falls back to text search when the probe is null and the query exists", async () => {
    const probe = async () => null;
    const result = await createWorkspaceSymbolsSource(deps({ probe })).collect();
    expect(result.fragments[0]?.provenance.kind).toBe("text-search");
    expect(result.details).toEqual({ count: 1, textSearch: true, dropped: 0 });
  });

  it("omits with empty when the fallback finds nothing", async () => {
    const api: LanguageApi = { ...baseApi(), textSearch: async () => [] };
    expect((await createWorkspaceSymbolsSource(deps({ api, probe: async () => null })).collect()).omittedReason).toBe("empty");
  });

  it("caps at 50 and marks truncated", async () => {
    const many = Array.from({ length: 55 }, (_, i) => wsSym(`s${i}`, `f${i}.ts`));
    const result = await createWorkspaceSymbolsSource(deps({ api: baseApi(many) })).collect();
    expect(result.fragments[0]?.content.split("\n")).toHaveLength(50);
    expect(result.fragments[0]?.provenance.truncated).toBe(true);
  });
});

describe("createDefinitionsSource", () => {
  const caps = { documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true };
  const loc = (path?: string, name?: string): LanguageLocation => ({
    uri: path !== undefined ? `file:///w/${path}` : "file:///w/src/a.ts",
    ...(path !== undefined ? { path } : {}),
    range: { start: at(2, 0), end: at(2, 5) },
    ...(name !== undefined ? { name } : {}),
  });
  const baseApi = (definitions: LanguageLocation[] = [loc("src/a.ts", "makeThing")]): LanguageApi => ({
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    definitions: async () => definitions,
    references: async () => [],
    diagnostics: async () => [],
    textSearch: async () => [{ uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(2, 0), end: at(2, 5) }, preview: "makeThing" }],
  });
  const deps = (over: Partial<LanguageSourceDeps> & { api?: LanguageApi } = {}): LanguageSourceDeps => ({
    api: over.api ?? baseApi(),
    policy: { includeCode: "workspace" },
    folderUri: "file:///w",
    cwd: "/w",
    activeUri: "file:///w/src/a.ts",
    activePath: "src/a.ts",
    activePosition: { line: 4, character: 6 },
    ...over,
  });

  it("has the definitions source id and priority", () => {
    const source = createDefinitionsSource(deps());
    expect(source.id).toBe("definitions");
    expect(source.priority).toBe(38);
  });

  it("omits with empty when there is no active uri or position", async () => {
    expect((await createDefinitionsSource(deps({ activeUri: undefined })).collect()).omittedReason).toBe("empty");
    expect((await createDefinitionsSource(deps({ activePosition: undefined })).collect()).omittedReason).toBe("empty");
  });

  it("omits with excluded when the active path is excluded", async () => {
    expect((await createDefinitionsSource(deps({ activePath: "node_modules/n/x.ts" })).collect()).omittedReason).toBe("excluded");
  });

  it("collects definitions with details", async () => {
    const result = await createDefinitionsSource(deps()).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:3:1 makeThing");
    expect(result.details).toEqual({ count: 1, dropped: 0 });
  });

  it("drops locations outside the workspace or excluded by policy", async () => {
    const api = baseApi([loc("src/a.ts", "in"), loc("/etc/hosts"), loc("credentials.json"), loc(undefined, "pathless")]);
    const result = await createDefinitionsSource(deps({ api })).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:3:1 in");
    expect(result.details).toEqual({ count: 1, dropped: 3 });
  });

  it("returns empty with a dropped count when every result is filtered out, without a fallback", async () => {
    let searched = false;
    const api: LanguageApi = {
      ...baseApi([loc("/etc/hosts"), loc("../outside.ts")]),
      textSearch: async () => {
        searched = true;
        return [];
      },
    };
    const result = await createDefinitionsSource(deps({ api, query: "makeThing" })).collect();
    expect(result.fragments).toEqual([]);
    expect(result.omittedReason).toBe("empty");
    expect(result.details).toEqual({ count: 0, dropped: 2 });
    expect(searched).toBe(false);
  });

  it("falls back to text search on null probe when a query exists, else unsupported", async () => {
    const probe = async () => null;
    const withQuery = await createDefinitionsSource(deps({ probe, query: "makeThing" })).collect();
    expect(withQuery.fragments[0]?.provenance.kind).toBe("text-search");
    expect(withQuery.details).toEqual({ count: 1, textSearch: true, dropped: 0 });
    expect((await createDefinitionsSource(deps({ probe })).collect()).omittedReason).toBe("unsupported");
  });

  it("omits with empty when nothing survives filtering and no query exists", async () => {
    const api = baseApi([loc("/etc/hosts")]);
    expect((await createDefinitionsSource(deps({ api })).collect()).omittedReason).toBe("empty");
  });

  it("caps at 20 and marks truncated", async () => {
    const many = Array.from({ length: 25 }, (_, i) => loc(`f${i}.ts`, `n${i}`));
    const result = await createDefinitionsSource(deps({ api: baseApi(many) })).collect();
    expect(result.fragments[0]?.content.split("\n")).toHaveLength(20);
    expect(result.fragments[0]?.provenance.truncated).toBe(true);
  });
});

describe("createReferencesSource", () => {
  const caps = { documentSymbols: true, workspaceSymbols: true, definitions: true, references: true, diagnostics: true };
  const loc = (path: string): LanguageLocation => ({
    uri: `file:///w/${path}`,
    path,
    range: { start: at(1, 0), end: at(1, 3) },
  });
  const baseApi = (references: LanguageLocation[] = [loc("src/a.ts")]): LanguageApi => ({
    documentSymbols: async () => [],
    workspaceSymbols: async () => [],
    definitions: async () => [],
    references: async () => references,
    diagnostics: async () => [],
    textSearch: async () => [],
  });
  const deps = (over: Partial<LanguageSourceDeps> & { api?: LanguageApi } = {}): LanguageSourceDeps => ({
    api: over.api ?? baseApi(),
    policy: { includeCode: "workspace" },
    folderUri: "file:///w",
    cwd: "/w",
    activeUri: "file:///w/src/a.ts",
    activePath: "src/a.ts",
    activePosition: { line: 4, character: 6 },
    query: "makeThing",
    ...over,
  });

  it("has the references source id and priority", () => {
    const source = createReferencesSource(deps());
    expect(source.id).toBe("references");
    expect(source.priority).toBe(39);
  });

  it("collects references with details", async () => {
    const result = await createReferencesSource(deps()).collect();
    expect(result.fragments[0]?.content).toBe("src/a.ts:2:1");
    expect(result.details).toEqual({ count: 1, dropped: 0 });
  });

  it("caps at 50 and marks truncated", async () => {
    const many = Array.from({ length: 60 }, (_, i) => loc(`f${i}.ts`));
    const result = await createReferencesSource(deps({ api: baseApi(many) })).collect();
    expect(result.fragments[0]?.content.split("\n")).toHaveLength(50);
    expect(result.fragments[0]?.provenance.truncated).toBe(true);
  });

  it("falls back to text search when the provider is unavailable", async () => {
    const probe = async () => ({ ...caps, references: false });
    const api: LanguageApi = { ...baseApi(), textSearch: async () => [({ uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: at(0, 0), end: at(0, 1) }, preview: "hit" }) as TextSearchMatch] };
    const result = await createReferencesSource(deps({ api, probe })).collect();
    expect(result.fragments[0]?.provenance.kind).toBe("text-search");
    expect(result.details).toEqual({ count: 1, textSearch: true, dropped: 0 });
  });

  it("omits with empty on a null probe when no query exists", async () => {
    expect((await createReferencesSource(deps({ probe: async () => null, query: undefined })).collect()).omittedReason).toBe("unsupported");
  });
});

describe("createLanguageSources", () => {
  const deps: LanguageSourceDeps = {
    api: {
      documentSymbols: async () => [],
      workspaceSymbols: async () => [],
      definitions: async () => [],
      references: async () => [],
      diagnostics: async () => [],
      textSearch: async () => [],
    },
    policy: { includeCode: "workspace" },
  };
  it("returns the five language sources in reserved order", () => {
    const sources = createLanguageSources(deps);
    expect(sources.map((s) => s.id)).toEqual(["diagnostics", "symbols", "workspace-symbols", "definitions", "references"]);
    expect(sources.map((s) => s.priority)).toEqual([45, 40, 37, 38, 39]);
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
