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
export function git(cwd: string, args: string[], exec: ExecFileLike = execFile): Promise<ExecResult> {
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
