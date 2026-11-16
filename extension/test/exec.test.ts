import { describe, expect, it, vi } from "vitest";
import { git, type ExecFileLike } from "../src/exec";

const options = { cwd: "/repo", timeout: 5000, maxBuffer: 1024 * 1024 };

describe("git", () => {
  it("passes git, the args and the timeout options to the executor", async () => {
    const exec = vi.fn<ExecFileLike>((_command, _args, _options, callback) => callback(null, "out", ""));
    const result = await git("/repo", ["status", "--porcelain"], exec);
    expect(result).toEqual({ ok: true, stdout: "out" });
    expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], options, expect.any(Function));
  });

  it("resolves a failure with the code and stderr, never an empty stdout", async () => {
    const error = Object.assign(new Error("git failed"), { code: 128 });
    const exec = vi.fn<ExecFileLike>((_command, _args, _options, callback) => callback(error, "", "fatal: not a git repository"));
    const result = await git("/repo", ["diff"], exec);
    expect(result).toEqual({ ok: false, code: undefined, stderr: "fatal: not a git repository" });
  });

  it("falls back to the error message when stderr is empty", async () => {
    const error = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    const exec = vi.fn<ExecFileLike>((_command, _args, _options, callback) => callback(error, "", "  \n"));
    const result = await git("/repo", ["diff"], exec);
    expect(result).toEqual({ ok: false, code: "ENOENT", stderr: "spawn git ENOENT" });
  });
});
