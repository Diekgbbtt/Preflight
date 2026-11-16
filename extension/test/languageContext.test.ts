// Ticket #37: language context provider tests. No vscode import here.
import { describe, expect, it, vi } from "vitest";
import { gitChangedFiles, gitStatus, rg, type ExecFileLike } from "../src/exec";

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
