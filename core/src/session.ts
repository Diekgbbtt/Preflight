import { createHash } from "node:crypto";
import type { ModelGap } from "./gaps";
import type { Category, Gap, GapPriority, GapSource, GapStatus } from "./types";

export type RevisionKind = "typed" | "merge";
export type SessionEnd = "send" | "copy" | "clear" | "replace";

/** What happened to one question during a session. Keyed by gapKey(). */
export interface GapRecord {
  category: Category;
  question: string;
  status: GapStatus;
  answer?: string;
  firstSeenRevision: number;
  /** For the session summary in the study log. */
  source: GapSource;
  priority: GapPriority;
}

/** One prompt from the first keystroke until it is sent, copied, cleared or replaced. */
export interface PromptSession {
  id: string;
  startedAt: number;
  revisions: { text: string; at: number; kind: RevisionKind }[];
  gapHistory: Map<string, GapRecord>;
  /** Raw quick-review output by textHash(); converted to gaps against the text it is reused for. */
  reviewCache: Map<string, ModelGap[]>;
  endedBy?: SessionEnd;
  endedAt?: number;
}

export function newSession(id: string, now: number): PromptSession {
  return { id, startedAt: now, revisions: [], gapHistory: new Map(), reviewCache: new Map() };
}

/** Lowercase, punctuation removed, whitespace collapsed. */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function gapKey(g: { category: Category; question: string }): string {
  return `${g.category}:${normalizeQuestion(g.question)}`;
}

/** The prompt as far as reviewing it is concerned: trimmed, whitespace collapsed, trailing punctuation ignored. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[\s.,;:!?…]+$/u, "");
}

export function textHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

export function recordRevision(s: PromptSession, text: string, kind: RevisionKind, now: number): void {
  s.revisions.push({ text, at: now, kind });
}

/** Remember gaps the user was shown. The first sighting wins; status changes go through markGap(). */
export function recordGaps(s: PromptSession, gaps: Gap[], revision: number): void {
  for (const g of gaps) {
    const key = gapKey(g);
    if (s.gapHistory.has(key)) continue;
    s.gapHistory.set(key, {
      category: g.category,
      question: g.question,
      status: "open",
      firstSeenRevision: revision,
      source: g.source,
      priority: g.priority,
    });
  }
}

export function markGap(s: PromptSession, g: Gap, status: "answered" | "dismissed", answer?: string, revision = 0): void {
  recordGaps(s, [g], revision);
  const r = s.gapHistory.get(gapKey(g))!;
  r.status = status;
  if (answer !== undefined) r.answer = answer;
}

// Words that carry no meaning for "is this the same question?".
const FILLER = new Set(
  "a an the this that these those it its to of for in on at by with and or is are be was were do does did should would could can will must you your i we what which how when where who whom why there any some".split(" "),
);

function tokens(q: string): Set<string> {
  return new Set(normalizeQuestion(q).split(" ").filter((t) => t && !FILLER.has(t)));
}

/** Shared meaningful words divided by the meaningful words of the shorter question (0..1). */
export function questionOverlap(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return normalizeQuestion(a) === normalizeQuestion(b) ? 1 : 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

/** True when the user already answered or dismissed a gap in the same category with a similar question. */
export function isSettled(s: PromptSession, g: { category: Category; question: string }): boolean {
  for (const r of s.gapHistory.values()) {
    if (r.category !== g.category || r.status === "open") continue;
    if (questionOverlap(r.question, g.question) >= 0.6) return true;
  }
  return false;
}
