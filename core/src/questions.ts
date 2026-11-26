// Answering deep-review questions (#15): build answer events and check the webview's answers message.
import type { Question } from "./deepFeedback";
import type { Event, EventInput } from "./repository";

export const MAX_ANSWER_CHARS = 2000;

/** Sent as the answer for a skipped question, so the next review does not ask it again. */
export const SKIPPED_ANSWER = "The user chose not to answer this.";

/** One checked answer: text is trimmed and filled from the option when the user typed nothing. */
export type AnswerInput = { id: string; text: string; option?: number } | { id: string; skip: true };

export type ParsedAnswers = { ok: true; answers: AnswerInput[] } | { ok: false; reason: string };

/** Neither answered nor skipped. In v1 an answered or skipped question stays closed. */
export function isOpen(question: Question): boolean {
  return !question.answer && !question.skippedAt;
}

export function openQuestions<T extends Question>(questions: T[]): T[] {
  return questions.filter(isOpen);
}

/** The follow-up event for one question: same id, the answer or skippedAt set, everything else kept. */
export function answerEvent(question: Event<Question>, input: AnswerInput, nowIso: string): EventInput<Question> {
  const { schemaVersion: _v, seq: _s, answer: _a, skippedAt: _k, ...rest } = question;
  if ("skip" in input) return { ...rest, ts: nowIso, skippedAt: nowIso };
  return {
    ...rest,
    ts: nowIso,
    answer: { text: input.text, ...(input.option !== undefined ? { option: input.option } : {}), answeredAt: nowIso },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Trust boundary for `{ type: "answers", draftId, answers }` from the webview.
 * All or nothing: one bad entry rejects the whole message, so nothing is saved halfway.
 * Reasons are short codes; they never contain answer or prompt text.
 */
export function parseAnswersMessage(raw: unknown, ctx: { draftId: string; open: Array<Event<Question>> }): ParsedAnswers {
  if (!isObject(raw)) return { ok: false, reason: "not-an-object" };
  if (raw.type !== "answers") return { ok: false, reason: "wrong-type" };
  if (raw.draftId !== ctx.draftId) return { ok: false, reason: "wrong-draft" };
  if (!Array.isArray(raw.answers) || raw.answers.length === 0) return { ok: false, reason: "no-answers" };
  if (raw.answers.length > ctx.open.length) return { ok: false, reason: "too-many" };

  const open = new Map(ctx.open.filter(isOpen).map((q) => [q.id, q]));
  const seen = new Set<string>();
  const answers: AnswerInput[] = [];
  for (const entry of raw.answers) {
    if (!isObject(entry) || typeof entry.id !== "string") return { ok: false, reason: "bad-entry" };
    const question = open.get(entry.id);
    if (!question) return { ok: false, reason: "unknown-or-closed-id" };
    if (seen.has(entry.id)) return { ok: false, reason: "duplicate-id" };
    seen.add(entry.id);

    if ("skip" in entry) {
      if (entry.skip !== true || "text" in entry || "option" in entry) return { ok: false, reason: "bad-skip" };
      answers.push({ id: entry.id, skip: true });
      continue;
    }

    let option: number | undefined;
    if (entry.option !== undefined) {
      const o = entry.option;
      if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o >= question.options.length) return { ok: false, reason: "bad-option" };
      option = o;
    }
    if (entry.text !== undefined && typeof entry.text !== "string") return { ok: false, reason: "bad-text" };
    // Free text wins over the option; an option alone answers with its own text.
    const text = (typeof entry.text === "string" ? entry.text.trim() : "") || (option !== undefined ? question.options[option] : "");
    if (!text) return { ok: false, reason: "empty-answer" };
    if (text.length > MAX_ANSWER_CHARS) return { ok: false, reason: "text-too-long" };
    answers.push({ id: entry.id, text, ...(option !== undefined ? { option } : {}) });
  }
  return { ok: true, answers };
}
