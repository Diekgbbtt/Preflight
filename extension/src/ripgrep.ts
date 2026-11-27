// Bundled ripgrep execution and parsing. Pure Node: no vscode import.
// The adapter injects the binary path and the executor in tests.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultExecFile, type ExecFileLike, type ExecResult } from "./exec";
import type { TextSearchMatch } from "./codeTools";
import { isOutsideWorkspace } from "./privacy";

/** Runs one bundled rg command with the shared timeout and buffer. */
export function runRipgrep(
  rgPath: string,
  args: string[],
  cwd: string,
  exec: ExecFileLike = defaultExecFile,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(rgPath, args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // rg exits 1 when the pattern matched nothing; stderr is empty then.
        if (error.code === 1 && stderr.trim() === "") {
          resolve({ ok: true, stdout });
          return;
        }
        resolve({
          ok: false,
          code: typeof error.code === "string" ? error.code : undefined,
          stderr: stderr.trim() || error.message,
        });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });
}

/** Parses rg --json match lines into workspace-relative matches. */
export function parseRipgrepJson(stdout: string, cwd: string): TextSearchMatch[] {
  const matches: TextSearchMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "match") continue;
    const data = (parsed as { data?: Record<string, unknown> }).data ?? {};
    const rawPath = (data.path as { text?: unknown } | undefined)?.text;
    if (typeof rawPath !== "string") continue;
    const relative = rawPath.replace(/^\.\//, "").replace(/\\/g, "/");
    if (isOutsideWorkspace(relative)) continue;
    const submatch = (data.submatches as Array<{ start?: unknown; end?: unknown }> | undefined)?.[0];
    const lineNumber = typeof data.line_number === "number" ? data.line_number - 1 : 0;
    const start = typeof submatch?.start === "number" ? submatch.start : 0;
    const end = typeof submatch?.end === "number" ? submatch.end : start;
    const preview = (data.lines as { text?: unknown } | undefined)?.text;
    matches.push({
      uri: pathToFileURL(path.resolve(cwd, relative)).href,
      path: relative.replace(/\\/g, "/"),
      range: { start: { line: lineNumber, character: start }, end: { line: lineNumber, character: end } },
      ...(typeof preview === "string" ? { preview } : {}),
    });
  }
  return matches;
}

/** Parses rg --files lines into unique workspace-relative paths. */
export function parseRipgrepFiles(stdout: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const raw = line.trim();
    if (raw === "") continue;
    const normalized = raw.replace(/^\.\//, "").replace(/\\/g, "/");
    if (isOutsideWorkspace(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }
  return files;
}

/** The bundled binary path inside the built extension. */
export function bundledRipgrepPath(extensionPath: string): string {
  return path.join(extensionPath, "dist", process.platform === "win32" ? "rg.exe" : "rg");
}
