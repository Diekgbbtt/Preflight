import { createHash } from "node:crypto";
import type { Level } from "./types";

/** Version of the shared review rubric. Bump when the anchors change. */
export const RUBRIC_VERSION = "v1";

/** Version of the quick and deep review prompt prose. Bump when the prose changes. */
export const PROMPT_VERSION = "v1";

export function hashPrompt(text: string): string {
  return createHash("sha256").update(text.trim().replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export function levelForScore(score: number): Level {
  return score >= 80 ? "clear" : score >= 55 ? "needs-work" : "vague";
}
