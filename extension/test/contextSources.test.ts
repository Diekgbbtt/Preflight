// Behavior tests for the basic context source collectors.
// The real `vscode` module is stubbed with a factory; this file never imports vscode.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_PRIORITIES } from "@prompt-preflight/core";
import { activePathFor, createActiveEditorSource, createGitDiffSource, createOpenEditorsSource, createSelectionSource, createTestCommandSource, resolveContextFolder } from "../src/contextSources";
import type { ContextSourceDeps } from "../src/contextSources";

// Mutable fake vscode surface, hoisted so the mock factory can read it.
const h = vi.hoisted(() => {
  const state = {
    activeTextEditor: undefined as unknown,
    textDocuments: [] as Array<{ uri: { scheme: string; fsPath: string }; getText: (range?: { start: number; end: number }) => string }>,
    workspaceFolders: [] as Array<{ uri: { fsPath: string; toString: () => string }; name: string; index: number }>,
    existingFiles: new Set<string>(),
    readFileError: false,
    asRelativePath: (uri: { fsPath: string; rel?: string }) => uri.rel ?? uri.fsPath,
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      state.workspaceFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath + "/") || uri.fsPath === f.uri.fsPath),
    stat: async (uri: { fsPath: string }) => {
      if (!state.existingFiles.has(uri.fsPath)) throw new Error("entry not found");
      return {};
    },
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
  };
  return state;
});

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() {
      return h.activeTextEditor;
    },
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => h.joinPath(base, ...parts),
  },
  workspace: {
    get textDocuments() {
      return h.textDocuments;
    },
    get workspaceFolders() {
      return h.workspaceFolders;
    },
    asRelativePath: (uri: { fsPath: string; rel?: string }, includeFolder?: boolean) => h.asRelativePath(uri, includeFolder),
    getWorkspaceFolder: (uri: { fsPath: string }) => h.getWorkspaceFolder(uri),
    fs: {
      stat: (uri: { fsPath: string }) => h.stat(uri),
      readFile: (uri: { fsPath: string }) => h.stat(uri).then(() => new Uint8Array()),
    },
  },
}));

const folder = { uri: { fsPath: "/ws", toString: () => "file:///ws" }, name: "ws", index: 0 };

/** A fake text document with a simple line/character-to-offset map. */
function doc(fsPath: string, text: string, scheme = "file") {
  const offsetAt = (pos: { line: number; character: number }) => {
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + pos.character;
  };
  return {
    uri: { scheme, fsPath },
    getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) =>
      range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
    offsetAt,
  };
}

const sel = (start: { line: number; character: number }, end: { line: number; character: number }, isEmpty = false) => ({
  start,
  end,
  isEmpty,
  isSingleLine: start.line === end.line,
  anchor: start,
  active: end,
});

const baseDeps = (over: Partial<ContextSourceDeps> = {}): ContextSourceDeps => ({ folder, policy: { includeCode: "workspace" }, ...over });

afterEach(() => {
  h.activeTextEditor = undefined;
  h.textDocuments = [];
  h.workspaceFolders = [];
  h.existingFiles = new Set();
  h.readFileError = false;
});

describe("createSelectionSource", () => {
  it("collects the selected text with its document range", async () => {
    const text = "line one\nline two";
    h.activeTextEditor = { document: doc("/ws/src/a.ts", text), selection: sel({ line: 1, character: 0 }, { line: 1, character: 8 }) };
    const result = await createSelectionSource(baseDeps()).collect();
    expect(result.fragments).toHaveLength(1);
    const fragment = result.fragments[0];
    expect(fragment.source).toBe("selection");
    expect(fragment.priority).toBe(SOURCE_PRIORITIES.selection);
    expect(fragment.content).toBe("line two");
    expect(fragment.provenance).toMatchObject({ kind: "selection", path: "src/a.ts", range: { start: 9, end: 17 }, truncated: false, chars: 8, folderUri: "file:///ws" });
    expect(fragment.provenance.redactions).toBeUndefined();
  });

  it("omits with empty when there is no active editor or an empty selection", async () => {
    expect(await createSelectionSource(baseDeps()).collect()).toEqual({ fragments: [], omittedReason: "empty" });
    h.activeTextEditor = { document: doc("/ws/src/a.ts", "text"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 0 }, true) };
    expect(await createSelectionSource(baseDeps()).collect()).toEqual({ fragments: [], omittedReason: "empty" });
  });

  it("omits with excluded when the privacy policy rejects the path", async () => {
    h.activeTextEditor = { document: doc("/ws/node_modules/pkg/index.js", "secret"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 6 }) };
    const result = await createSelectionSource(baseDeps()).collect();
    expect(result).toEqual({ fragments: [], omittedReason: "excluded" });
  });

  it("allows an untitled selection with an empty path", async () => {
    h.activeTextEditor = { document: doc("untitled:1", "draft text", "untitled"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 10 }) };
    const result = await createSelectionSource(baseDeps()).collect();
    expect(result.fragments[0]?.provenance.path).toBe("");
  });
});

describe("createActiveEditorSource", () => {
  it("omits with empty when a non-empty selection replaces the active file", async () => {
    h.activeTextEditor = { document: doc("/ws/src/a.ts", "full text"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 4 }) };
    const result = await createActiveEditorSource(baseDeps()).collect();
    expect(result).toEqual({ fragments: [], omittedReason: "empty" });
  });

  it("collects the full document text when nothing is selected", async () => {
    h.activeTextEditor = { document: doc("/ws/src/a.ts", "full text"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 0 }, true) };
    const result = await createActiveEditorSource(baseDeps()).collect();
    expect(result.fragments[0]).toMatchObject({ source: "active-editor", priority: 70, content: "full text", provenance: { kind: "active-file", path: "src/a.ts", truncated: false, folderUri: "file:///ws" } });
  });

  it("omits with empty when there is no editor and excluded for untitled or rejected paths", async () => {
    expect(await createActiveEditorSource(baseDeps()).collect()).toEqual({ fragments: [], omittedReason: "empty" });
    h.activeTextEditor = { document: doc("scratch", "text", "untitled"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 0 }, true) };
    expect(await createActiveEditorSource(baseDeps()).collect()).toEqual({ fragments: [], omittedReason: "excluded" });
    h.activeTextEditor = { document: doc("/ws/.env.local", "SECRET=1"), selection: sel({ line: 0, character: 0 }, { line: 0, character: 0 }, true) };
    expect(await createActiveEditorSource(baseDeps()).collect()).toEqual({ fragments: [], omittedReason: "excluded" });
  });
});

describe("createOpenEditorsSource", () => {
  it("collects one fragment per eligible document, skipping the active one", async () => {
    const active = doc("/ws/src/active.ts", "active");
    const other = doc("/ws/src/other.ts", "other body");
    const untitled = doc("scratch-1", "draft", "untitled");
    const excluded = doc("/ws/node_modules/lib/index.js", "lib");
    const emptyDoc = doc("/ws/src/empty.ts", "");
    h.activeTextEditor = { document: active, selection: sel({ line: 0, character: 0 }, { line: 0, character: 0 }, true) };
    h.textDocuments = [active, other, untitled, excluded, emptyDoc];
    const result = await createOpenEditorsSource(baseDeps()).collect();
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({ source: "open-editors", priority: 60, content: "other body", provenance: { kind: "open-editor", path: "src/other.ts", folderUri: "file:///ws" } });
    expect(result.details).toEqual({ files: 1 });
  });

  it("omits with empty when nothing eligible remains", async () => {
    h.textDocuments = [doc("/ws/src/empty.ts", "")];
    const result = await createOpenEditorsSource(baseDeps()).collect();
    expect(result).toEqual({ fragments: [], omittedReason: "empty" });
  });
});

describe("createGitDiffSource", () => {
  const fakeGit = (stdout: string, ok = true, stderr = "") =>
    async () => (ok ? { ok: true as const, stdout } : { ok: false as const, stderr });

  it("joins included diff sections into one fragment and drops excluded files", async () => {
    const diffText = [
      "diff --git a/src/keep.ts b/src/keep.ts",
      "index 111..222 100644",
      "--- a/src/keep.ts",
      "+++ b/src/keep.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "diff --git a/node_modules/pkg/index.js b/node_modules/pkg/index.js",
      "--- a/node_modules/pkg/index.js",
      "+++ b/node_modules/pkg/index.js",
      "+lib",
    ].join("\n");
    const result = await createGitDiffSource(baseDeps({ git: fakeGit(diffText) })).collect();
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({ source: "git-diff", priority: 50, provenance: { kind: "git-diff", truncated: false, folderUri: "file:///ws" } });
    expect(result.fragments[0].provenance.path).toBeUndefined();
    expect(result.fragments[0].content).toContain("diff --git a/src/keep.ts");
    expect(result.fragments[0].content).not.toContain("node_modules");
    expect(result.details).toEqual({ files: 1, dropped: 1 });
  });

  it("omits with unsupported when there is no folder or git fails", async () => {
    expect(await createGitDiffSource(baseDeps({ folder: undefined })).collect()).toEqual({ fragments: [], omittedReason: "unsupported" });
    const failed = await createGitDiffSource(baseDeps({ git: fakeGit("", false, "fatal: not a git repository") })).collect();
    expect(failed).toEqual({ fragments: [], omittedReason: "unsupported" });
  });

  it("omits with empty when the diff is empty", async () => {
    expect(await createGitDiffSource(baseDeps({ git: fakeGit("") })).collect()).toEqual({ fragments: [], omittedReason: "empty" });
  });
});

describe("createTestCommandSource", () => {
  const read = (body: string) => async () => new TextEncoder().encode(body);

  it("returns the test script string without executing it", async () => {
    const result = await createTestCommandSource(baseDeps({ readFile: read('{"scripts":{"test":"vitest run"}}') })).collect();
    expect(result.fragments[0]).toMatchObject({ source: "test-command", priority: 30, content: "vitest run", provenance: { kind: "test-command", path: "package.json", folderUri: "file:///ws" } });
    expect(result.details).toEqual({ script: "test" });
  });

  it("omits with empty for a missing file, invalid JSON or a missing script", async () => {
    const missing = async () => {
      throw new Error("entry not found");
    };
    expect(await createTestCommandSource(baseDeps({ readFile: missing })).collect()).toEqual({ fragments: [], omittedReason: "empty" });
    expect(await createTestCommandSource(baseDeps({ readFile: read("not json") })).collect()).toEqual({ fragments: [], omittedReason: "empty" });
    expect(await createTestCommandSource(baseDeps({ readFile: read('{"scripts":{}}') })).collect()).toEqual({ fragments: [], omittedReason: "empty" });
  });

  it("omits with unsupported when there is no folder", async () => {
    expect(await createTestCommandSource(baseDeps({ folder: undefined })).collect()).toEqual({ fragments: [], omittedReason: "unsupported" });
  });
});

describe("activePathFor", () => {
  it("returns a workspace-relative POSIX path inside the folder and ../ outside", () => {
    expect(activePathFor({ scheme: "file", fsPath: "/ws/src/a.ts" } as never, folder as never)).toBe("src/a.ts");
    expect(activePathFor({ scheme: "file", fsPath: "/other/b.ts" } as never, folder as never)).toBe("../other/b.ts");
  });

  it("returns an empty string for untitled and non-file URIs", () => {
    expect(activePathFor({ scheme: "untitled", fsPath: "scratch" } as never, folder as never)).toBe("");
    expect(activePathFor({ scheme: "output", fsPath: "/x" } as never, folder as never)).toBe("");
  });
});

describe("resolveContextFolder", () => {
  it("returns the first folder where a draft path reference exists", async () => {
    const other = { uri: { fsPath: "/other", toString: () => "file:///other" }, name: "other", index: 1 };
    h.workspaceFolders = [folder, other];
    h.existingFiles = new Set(["/other/src/app.ts"]);
    const resolved = await resolveContextFolder("please fix src/app.ts");
    expect(resolved).toBe(other);
  });

  it("falls back to the active editor folder and to undefined", async () => {
    h.workspaceFolders = [folder];
    expect(await resolveContextFolder("no refs here", { fsPath: "/ws/src/a.ts" } as never)).toBe(folder);
    h.workspaceFolders = [];
    expect(await resolveContextFolder("no refs here", { fsPath: "/ws/src/a.ts" } as never)).toBeUndefined();
  });
});
