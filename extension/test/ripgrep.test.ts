import { describe, expect, it, vi } from "vitest";
import type { ExecFileLike } from "../src/exec";
import { bundledRipgrepPath, parseRipgrepFiles, parseRipgrepJson, runRipgrep } from "../src/ripgrep";

const options = { cwd: "/repo", timeout: 5000, maxBuffer: 1024 * 1024 };
const jsonLine = (data: object): string => `${JSON.stringify({ type: "match", data })}\n`;

describe("runRipgrep", () => {
  it("runs the injected binary path with the args and timeout options", async () => {
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(null, "out", ""));
    const result = await runRipgrep("/w/dist/rg", ["--json", "pat"], "/repo", exec);
    expect(exec).toHaveBeenCalledWith("/w/dist/rg", ["--json", "pat"], options, expect.any(Function));
    expect(result).toEqual({ ok: true, stdout: "out" });
  });

  it("treats exit code 1 with no stderr as a successful empty result", async () => {
    const error = Object.assign(new Error("no matches"), { code: 1 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", ""));
    await expect(runRipgrep("/w/dist/rg", ["pat"], "/repo", exec)).resolves.toEqual({ ok: true, stdout: "" });
  });

  it("returns the failure code and stderr", async () => {
    const error = Object.assign(new Error("rg failed"), { code: 2 });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", "unrecognized flag"));
    await expect(runRipgrep("/w/dist/rg", ["pat"], "/repo", exec)).resolves.toEqual({ ok: false, code: undefined, stderr: "unrecognized flag" });
  });

  it("preserves the ENOENT code", async () => {
    const error = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
    const exec = vi.fn<ExecFileLike>((_c, _a, _o, cb) => cb(error, "", ""));
    await expect(runRipgrep("/w/dist/rg", ["pat"], "/repo", exec)).resolves.toMatchObject({ ok: false, code: "ENOENT" });
  });
});

describe("parseRipgrepJson", () => {
  it("parses match lines into workspace-relative matches", () => {
    const matches = parseRipgrepJson(
      jsonLine({ path: { text: "src/a.ts" }, line_number: 5, submatches: [{ start: 2, end: 10 }], lines: { text: "  const x = makeThing();\n" } }),
      "/w",
    );
    expect(matches).toEqual([
      { uri: "file:///w/src/a.ts", path: "src/a.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } }, preview: "  const x = makeThing();\n" },
    ]);
  });

  it("drops absolute and outside paths, and skips non-match lines", () => {
    const matches = parseRipgrepJson(
      [
        JSON.stringify({ type: "begin", data: {} }),
        "not json",
        jsonLine({ path: { text: "/etc/hosts" }, line_number: 1, submatches: [{ start: 0, end: 1 }] }),
        jsonLine({ path: { text: "../outside.ts" }, line_number: 1, submatches: [{ start: 0, end: 1 }] }),
        jsonLine({ path: { text: "kept.ts" }, line_number: 1, submatches: [{ start: 0, end: 1 }] }),
      ].join("\n"),
      "/w",
    );
    expect(matches.map((match) => match.path)).toEqual(["kept.ts"]);
  });

  it("caps at maxResults", () => {
    const lines = Array.from({ length: 5 }, (_, i) => jsonLine({ path: { text: `f${i}.ts` }, line_number: 1, submatches: [{ start: 0, end: 1 }] })).join("");
    expect(parseRipgrepJson(lines, "/w", 2)).toHaveLength(2);
  });
});

describe("parseRipgrepFiles", () => {
  it("returns unique workspace-relative paths and caps", () => {
    expect(parseRipgrepFiles("src/a.ts\nsrc/a.ts\nsrc/b.ts\n")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(parseRipgrepFiles("a.ts\nb.ts\nc.ts\n", 2)).toEqual(["a.ts", "b.ts"]);
  });

  it("drops outside paths", () => {
    expect(parseRipgrepFiles("/etc/hosts\n../secret\nsrc/a.ts\n")).toEqual(["src/a.ts"]);
  });
});

describe("bundledRipgrepPath", () => {
  it("points inside the built extension", () => {
    const path = bundledRipgrepPath("/ext");
    expect(path).toBe(`/ext/dist/${process.platform === "win32" ? "rg.exe" : "rg"}`);
  });
});
