import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPromptFilesResult,
  resolvePromptFileRefs,
  type PromptFileContent,
  type WorkspaceRoot,
} from "../src/promptFiles";

const roots: WorkspaceRoot[] = [
  { uri: "file:///repo", fsPath: "/repo" },
  { uri: "file:///repo2", fsPath: "/repo2" },
];

const existsIn = (paths: string[]) => {
  const set = new Set(paths);
  return async (candidate: string) => set.has(candidate);
};

describe("resolvePromptFileRefs", () => {
  it("resolves a file inside the owning root", async () => {
    const result = await resolvePromptFileRefs(["src/app.ts"], roots, existsIn(["/repo/src/app.ts"]));
    expect(result.files).toEqual([
      { ref: "src/app.ts", path: "src/app.ts", fsPath: "/repo/src/app.ts", folderUri: "file:///repo" },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("normalizes ./, backslashes, and duplicate references", async () => {
    const result = await resolvePromptFileRefs(
      ["./src/app.ts", "src\\app.ts"],
      roots,
      existsIn(["/repo/src/app.ts"]),
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/app.ts");
    expect(result.duplicate).toBe(1);
  });

  it("resolves across multiple roots and reports an ambiguous reference", async () => {
    const result = await resolvePromptFileRefs(["shared.ts", "lib/only.ts"], roots, existsIn(["/repo/shared.ts", "/repo2/shared.ts", "/repo2/lib/only.ts"]));
    expect(result.ambiguous).toEqual(["shared.ts"]);
    expect(result.files).toEqual([{ ref: "lib/only.ts", path: "lib/only.ts", fsPath: "/repo2/lib/only.ts", folderUri: "file:///repo2" }]);
  });

  it("reports missing references", async () => {
    const result = await resolvePromptFileRefs(["src/missing.ts"], roots, existsIn([]));
    expect(result.files).toEqual([]);
    expect(result.missing).toEqual(["src/missing.ts"]);
  });

  it.each(["/etc/passwd", "C:/Users/x/app.ts", "../secret.ts", "src/../../secret.ts"])("rejects outside reference %s", async (ref) => {
    const result = await resolvePromptFileRefs([ref], roots, existsIn([ref]));
    expect(result.files).toEqual([]);
    expect(result.outside).toEqual([ref]);
  });

  it("bridges win32 paths with path.win32 and still returns POSIX relative paths", async () => {
    const winRoots: WorkspaceRoot[] = [{ uri: "file:///C:/repo", fsPath: "C:\\repo" }];
    const result = await resolvePromptFileRefs(
      ["src\\app.ts", "..\\secret.ts"],
      winRoots,
      existsIn(["C:\\repo\\src\\app.ts"]),
      path.win32,
    );
    expect(result.files).toEqual([{ ref: "src\\app.ts", path: "src/app.ts", fsPath: "C:\\repo\\src\\app.ts", folderUri: "file:///C:/repo" }]);
    expect(result.outside).toEqual(["..\\secret.ts"]);
  });
});

const content = (over: Partial<PromptFileContent> = {}): PromptFileContent => ({
  path: "src/app.ts",
  folderUri: "file:///repo",
  content: "export const app = 1;",
  ...over,
});

describe("buildPromptFilesResult", () => {
  const base = {
    files: [content()],
    policy: { includeCode: "prompt-files" as const, promptFiles: ["src/app.ts"] },
    missing: 0,
    outside: 0,
    ambiguous: 0,
    excluded: 0,
    duplicate: 0,
    unreadable: 0,
  };

  it("builds one prompt-file fragment per referenced file", () => {
    const result = buildPromptFilesResult(base);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({
      source: "prompt-files",
      priority: 80,
      content: "export const app = 1;",
      tokens: 6,
      provenance: { kind: "prompt-file", path: "src/app.ts", folderUri: "file:///repo", truncated: false, chars: 21 },
    });
    expect(result.details).toEqual({ files: 1, dropped: 0, missing: 0, ambiguous: 0, excluded: 0, duplicate: 0, unreadable: 0 });
  });

  it("excludes an unreferenced file, an excluded path, and everything under off", () => {
    const unreferenced = buildPromptFilesResult({
      ...base,
      files: [content({ path: "src/other.ts" })],
      policy: { includeCode: "prompt-files", promptFiles: ["src/app.ts"] },
    });
    expect(unreferenced.fragments).toEqual([]);
    expect(unreferenced.omittedReason).toBe("excluded");

    const excluded = buildPromptFilesResult({
      ...base,
      files: [content({ path: "dist/app.js", content: "x" })],
      policy: { includeCode: "prompt-files", promptFiles: ["dist/app.js"] },
    });
    expect(excluded.fragments).toEqual([]);
    expect(excluded.omittedReason).toBe("excluded");

    const off = buildPromptFilesResult({ ...base, policy: { includeCode: "off" } });
    expect(off.fragments).toEqual([]);
    expect(off.omittedReason).toBe("excluded");
  });

  it("keeps the files it can and records missing and unreadable counts", () => {
    const result = buildPromptFilesResult({
      ...base,
      files: [content(), content({ path: "src/empty.ts", content: "   " })],
      policy: { includeCode: "prompt-files", promptFiles: ["src/app.ts", "src/empty.ts"] },
      missing: 2,
      unreadable: 1,
    });
    expect(result.fragments).toHaveLength(1);
    expect(result.details).toEqual({ files: 1, dropped: 0, missing: 2, ambiguous: 0, excluded: 0, duplicate: 0, unreadable: 1 });
  });

  it("omits empty when only missing references exist", () => {
    const result = buildPromptFilesResult({ ...base, files: [], missing: 1 });
    expect(result.fragments).toEqual([]);
    expect(result.omittedReason).toBe("empty");
  });

  it("omits error when every resolved file was unreadable", () => {
    const result = buildPromptFilesResult({ ...base, files: [], unreadable: 1 });
    expect(result.fragments).toEqual([]);
    expect(result.omittedReason).toBe("error");
  });
});
