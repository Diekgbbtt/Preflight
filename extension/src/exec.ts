// Shared process-execution seam for the extension. Pure Node: no vscode import.
// Callers inject a fake executor in tests; nothing here uses a shell.
import { execFile } from "node:child_process";

export type ExecResult = { ok: true; stdout: string } | { ok: false; code?: string; stderr: string };

export type ExecFileLike = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
  callback: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void,
) => void;

/**
 * Runs one git command with a 5-second timeout and a 1 MB buffer.
 * Failure never resolves to an empty stdout string: the result carries the
 * error code and the trimmed stderr, or the error message when stderr is empty.
 */
export function git(cwd: string, args: string[], exec: ExecFileLike = defaultExecFile): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
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

/**
 * Runs one ripgrep command with a 5-second timeout and a 1 MB buffer.
 * Exit code 1 with no stderr means "no matches": a successful empty result,
 * not an error. A missing rg reports `code: "ENOENT"`; the caller omits the
 * source as unsupported instead of substituting grep. Never uses a shell.
 */
export function rg(args: string[], cwd: string, exec: ExecFileLike = defaultExecFile): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec("rg", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

/** Adapts the overloaded execFile to the single ExecFileLike signature. */
const defaultExecFile: ExecFileLike = (command, args, options, callback) => {
  execFile(command, args, options, (error, stdout, stderr) =>
    callback(error as unknown as (Error & { code?: string | number }) | null, stdout, stderr),
  );
};
