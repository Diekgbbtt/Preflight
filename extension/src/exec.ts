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

/** Highest entry count git status and changed-file results may carry. */
export const MAX_GIT_ENTRIES = 200;

/** One porcelain v1 status row: the two status chars and the path. */
export interface GitStatusEntry {
  status: string;
  path: string;
}

export type GitStatusResult = { ok: true; entries: GitStatusEntry[]; truncated: boolean } | { ok: false; code?: string; stderr: string };

export type GitChangedFilesResult = { ok: true; files: string[]; truncated: boolean } | { ok: false; code?: string; stderr: string };

/**
 * Runs `git status --porcelain=v1 -z` and parses the NUL-separated rows.
 * Paths keep their spaces and newlines because of `-z`; the extra NUL
 * segment after a rename or copy entry is the original path and is skipped.
 */
export async function gitStatus(cwd: string, exec: ExecFileLike = defaultExecFile): Promise<GitStatusResult> {
  const result = await git(cwd, ["status", "--porcelain=v1", "-z"], exec);
  if (!result.ok) return { ok: false, code: result.code, stderr: result.stderr };
  const all: GitStatusEntry[] = [];
  const fields = result.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field === "") continue;
    const status = field.slice(0, 2);
    all.push({ status, path: field.slice(3) });
    if (status.includes("R") || status.includes("C")) i++; // the next segment is the original path
  }
  return { ok: true, entries: all.slice(0, MAX_GIT_ENTRIES), truncated: all.length > MAX_GIT_ENTRIES };
}

/**
 * Changed files = status paths plus the file names of the last five commits
 * (`git log -n 5 --name-only --format= -z`, NUL-separated), unique and sorted.
 * A log failure keeps the status paths; only a status failure is an error.
 */
export async function gitChangedFiles(cwd: string, exec: ExecFileLike = defaultExecFile): Promise<GitChangedFilesResult> {
  const status = await gitStatus(cwd, exec);
  if (!status.ok) return { ok: false, code: status.code, stderr: status.stderr };
  const log = await git(cwd, ["log", "-n", "5", "--name-only", "--format=", "-z"], exec);
  const names = new Set(status.entries.map((entry) => entry.path));
  if (log.ok) {
    for (const name of log.stdout.split("\0")) {
      if (name !== "") names.add(name);
    }
  }
  const files = [...names].sort();
  return { ok: true, files: files.slice(0, MAX_GIT_ENTRIES), truncated: status.truncated || files.length > MAX_GIT_ENTRIES };
}

/** Adapts the overloaded execFile to the single ExecFileLike signature. */
const defaultExecFile: ExecFileLike = (command, args, options, callback) => {
  execFile(command, args, options, (error, stdout, stderr) =>
    callback(error as unknown as (Error & { code?: string | number }) | null, stdout, stderr),
  );
};
