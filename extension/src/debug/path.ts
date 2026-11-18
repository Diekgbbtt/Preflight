import * as path from "node:path";

export const DEBUG_DIR_NAME = "debug";
export const DEBUG_FILE_NAME = "llm-trace.jsonl";
export const DEBUG_HISTORY_NAME = ".llm-trace.history";
export const DEBUG_MAX_SIZE = "10M";
export const DEBUG_MAX_FILES = 5;

type PathApi = Pick<typeof path, "isAbsolute" | "normalize" | "resolve" | "join">;

/** Resolves the directory setting. Empty uses the extension global storage. */
export function resolveDebugLogDir(
  globalStoragePath: string,
  setting: string,
  pathApi: PathApi = path,
): string {
  const value = setting.trim();
  if (!value) return pathApi.join(globalStoragePath, DEBUG_DIR_NAME);
  if (pathApi.isAbsolute(value)) return pathApi.normalize(value);
  return pathApi.resolve(globalStoragePath, value);
}

/** The unrotated JSONL file path. */
export function debugLogFile(dir: string, pathApi: Pick<typeof path, "join"> = path): string {
  return pathApi.join(dir, DEBUG_FILE_NAME);
}

/** True for the current file, a rotated file, or the rotation history. */
export function isDebugTraceFile(name: string): boolean {
  return /^llm-trace(?:\.\d+)?\.jsonl$/.test(name) || name === DEBUG_HISTORY_NAME;
}
