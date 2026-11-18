import * as path from "node:path";
import { mkdtemp, mkdir, writeFile, symlink, stat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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

const identityPath = async (candidate: string) => candidate;

const existsIn = (paths: string[]) => {
  const set = new Set(paths);
  return async (candidate: string) => set.has(candidate);
};

describe("resolvePromptFileRefs", () => {
  it("resolves a file inside the owning root", async () => {
    const result = await resolvePromptFileRefs(["src/app.ts"], roots, existsIn(["/repo/src/app.ts"]), identityPath);
    expect(result.files).toEqual([
      { ref: "src/app.ts", path: "src/app.ts", fsPath: "/repo/src/app.ts", folderUri: "file:///repo" },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("normalizes ./, backslashes, and duplicate references", async () => {
    const result = await resolvePromptFileRefs(
      ["./src/app.ts", "src\\app.ts"],
      roots,
      existsIn(["/repo/src/app.ts"]), identityPath,
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("src/app.ts");
    expect(result.duplicate).toBe(1);
  });

  it("resolves across multiple roots and reports an ambiguous reference", async () => {
    const result = await resolvePromptFileRefs(["shared.ts", "lib/only.ts"], roots, existsIn(["/repo/shared.ts", "/repo2/shared.ts", "/repo2/lib/only.ts"]), identityPath);
    expect(result.ambiguous).toEqual(["shared.ts"]);
    expect(result.files).toEqual([{ ref: "lib/only.ts", path: "lib/only.ts", fsPath: "/repo2/lib/only.ts", folderUri: "file:///repo2" }]);
  });

  it("reports missing references", async () => {
    const result = await resolvePromptFileRefs(["src/missing.ts"], roots, existsIn([]), identityPath);
    expect(result.files).toEqual([]);
    expect(result.missing).toEqual(["src/missing.ts"]);
  });

  it.each(["/etc/passwd", "C:/Users/x/app.ts", "../secret.ts", "src/../../secret.ts"])("rejects outside reference %s", async (ref) => {
    const result = await resolvePromptFileRefs([ref], roots, existsIn([ref]), identityPath);
    expect(result.files).toEqual([]);
    expect(result.outside).toEqual([ref]);
  });

  it("dedupes case-insensitively on Windows", async () => {
    const winRoots: WorkspaceRoot[] = [{ uri: "file:///C:/repo", fsPath: "C:\\repo" }];
    const result = await resolvePromptFileRefs(
      ["src/App.ts", "src/app.ts"],
      winRoots,
      existsIn(["C:\\repo\\src\\App.ts", "C:\\repo\\src\\app.ts"]),
      identityPath, path.win32,
    );
    expect(result.files).toHaveLength(1);
    expect(result.duplicate).toBe(1);
  });

  it("bridges win32 paths with path.win32 and still returns POSIX relative paths", async () => {
    const winRoots: WorkspaceRoot[] = [{ uri: "file:///C:/repo", fsPath: "C:\\repo" }];
    const result = await resolvePromptFileRefs(
      ["src\\app.ts", "..\\secret.ts"],
      winRoots,
      existsIn(["C:\\repo\\src\\app.ts"]),
      identityPath, path.win32,
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

// File symlinks need developer-mode privileges on Windows; win32 lexical
// containment remains covered above, with canonical target cases below.
describe.skipIf(process.platform === "win32")("canonical prompt-file targets", () => {
  it.each(["external", "excluded", "allowed"] as const)("handles an %s symlink target before it can be read", async (kind) => {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-prompt-path-"));
    try {
      const root = path.join(dir, "workspace");
      await mkdir(root);
      const target = kind === "external" ? path.join(dir, ".env") : path.join(root, kind === "excluded" ? ".env" : "real.ts");
      await writeFile(target, "private fixture text");
      await symlink(target, path.join(root, "alias.ts"));
      const result = await resolvePromptFileRefs(
        ["alias.ts", ...(kind === "allowed" ? ["real.ts"] : [])],
        [{ uri: pathToFileURL(root).href, fsPath: root }],
        async (file) => !!(await stat(file).catch(() => null)),
        realpath,
      );
      if (kind === "allowed") {
        expect(result.files).toEqual([{
          ref: "alias.ts", path: "real.ts", fsPath: await realpath(target), folderUri: pathToFileURL(root).href,
        }]);
        expect(result.duplicate).toBe(1);
      } else {
        expect(result.files).toEqual([]);
        expect(kind === "external" ? result.outside : result.excluded).toEqual(["alias.ts"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows a workspace root which is itself a symlink", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-root-path-"));
    try {
      const target = path.join(dir, "real-root");
      const root = path.join(dir, "workspace");
      await mkdir(target);
      await writeFile(path.join(target, "app.ts"), "export {};");
      await symlink(target, root, "dir");
      const result = await resolvePromptFileRefs(
        ["app.ts"], [{ uri: pathToFileURL(root).href, fsPath: root }],
        async (file) => !!(await stat(file).catch(() => null)), realpath,
      );
      expect(result.files[0]).toMatchObject({ path: "app.ts", fsPath: await realpath(path.join(target, "app.ts")) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("rejects canonical targets on another Windows drive", async () => {
  const result = await resolvePromptFileRefs(
    ["alias.ts"], [{ uri: "file:///C:/repo", fsPath: "C:/repo" }], async () => true,
    async (candidate) => candidate.endsWith("alias.ts") ? "D:/private/file.ts" : "C:/repo",
    path.win32,
  );
  expect(result.files).toEqual([]);
  expect(result.outside).toEqual(["alias.ts"]);
});

it("fails closed when a canonical target cannot be resolved", async () => {
  const result = await resolvePromptFileRefs(
    ["alias.ts"], roots, async () => true,
    async () => { throw new Error("unreadable target"); },
  );
  expect(result.files).toEqual([]);
});
