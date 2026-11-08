/** Which part of a good prompt a finding is about. */
export type Category =
  | "target" // where: file, function, component
  | "action" // what: a concrete change
  | "scope" // how much: bounded, one task
  | "done" // success criteria: expected behaviour, tests
  | "clarity" // vague wording, pronouns, placeholders
  | "risk" // destructive or production work
  | "privacy"; // secrets in the prompt

export type Severity = "info" | "warning" | "error";

/** Character offsets into the prompt, end exclusive. */
export interface Range {
  start: number;
  end: number;
}

export interface Finding {
  rule: string;
  category: Category;
  severity: Severity;
  message: string;
  range?: Range;
}

/** Four parts of the score, 0–25 each. */
export interface Dimensions {
  target: number;
  action: number;
  scope: number;
  done: number;
}

export type Level = "trivial" | "clear" | "needs-work" | "vague";

export interface Analysis {
  level: Level;
  /** 0–100, sum of the dimensions. */
  score: number;
  dimensions: Dimensions;
  findings: Finding[];
  /** At most three clarifying questions, most important first. */
  questions: string[];
  /** True when the prompt should not be sent as is. */
  shouldClarify: boolean;
  /** True when the prompt contains the [preflight:skip] marker. */
  skipped: boolean;
}

/** What the checker may know about the user's project. All optional. */
export interface WorkspaceContext {
  /** Whether a referenced path exists in the project. */
  fileExists?(ref: string): boolean;
  /** Recently changed files (e.g. from git status), offered as candidates. */
  recentFiles?: string[];
}
