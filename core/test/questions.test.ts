import { describe, expect, it } from "vitest";
import {
  answerEvent,
  MAX_ANSWER_CHARS,
  openQuestions,
  parseAnswersMessage,
  qaFrom,
  SCHEMA_VERSION,
  SKIPPED_ANSWER,
  type Event,
  type Question,
} from "../src/index";

let seq = 0;
const q = (id: string, over: Partial<Question> = {}): Event<Question> => ({
  schemaVersion: SCHEMA_VERSION,
  seq: ++seq,
  id,
  ts: "2026-11-26T10:00:00.000Z",
  draftId: "d1",
  reviewId: "r1",
  question: `question ${id}`,
  why: "why",
  options: ["admin", "customer"],
  ...over,
});

const open = [q("q1"), q("q2"), q("q3", { options: [] })];
const msg = (answers: unknown, over: Record<string, unknown> = {}) => ({ type: "answers", draftId: "d1", answers, ...over });
const parse = (raw: unknown, questions = open) => parseAnswersMessage(raw, { draftId: "d1", open: questions });

describe("openQuestions", () => {
  it("keeps only questions that are neither answered nor skipped", () => {
    const all = [q("a"), q("b", { answer: { text: "x", answeredAt: "t" } }), q("c", { skippedAt: "t" })];
    expect(openQuestions(all).map((x) => x.id)).toEqual(["a"]);
    // A blank answer is not sent as Q&A (qaFrom), so the question stays open too.
    expect(openQuestions([q("d", { answer: { text: "  ", answeredAt: "t" } })]).map((x) => x.id)).toEqual(["d"]);
  });
});

describe("parseAnswersMessage", () => {
  it("accepts free text, an option alone, free text over an option, and a skip", () => {
    expect(
      parse(
        msg([
          { id: "q1", text: "  the admin login  " },
          { id: "q2", option: 1 },
          { id: "q3", skip: true },
        ]),
      ),
    ).toEqual({ ok: true, answers: [{ id: "q1", text: "the admin login" }, { id: "q2", text: "customer", option: 1 }, { id: "q3", skip: true }] });
    expect(parse(msg([{ id: "q1", text: "both, really", option: 0 }]))).toEqual({ ok: true, answers: [{ id: "q1", text: "both, really", option: 0 }] });
  });

  it.each([
    ["not an object", "answers", "not-an-object"],
    ["wrong type", { ...msg([{ id: "q1", text: "x" }]), type: "send" }, "wrong-type"],
    ["another draft", msg([{ id: "q1", text: "x" }], { draftId: "d2" }), "wrong-draft"],
    ["no answers", msg([]), "no-answers"],
    ["answers not a list", msg({ id: "q1" }), "no-answers"],
    ["more answers than open questions", msg([1, 2, 3, 4].map((n) => ({ id: `q${n}`, text: "x" }))), "too-many"],
    ["entry without id", msg([{ text: "x" }]), "bad-entry"],
    ["unknown id", msg([{ id: "nope", text: "x" }]), "unknown-or-closed-id"],
    ["same id twice", msg([{ id: "q1", text: "x" }, { id: "q1", text: "y" }]), "duplicate-id"],
    ["skip that is not true", msg([{ id: "q1", skip: "yes" }]), "bad-skip"],
    ["skip with text", msg([{ id: "q1", skip: true, text: "x" }]), "bad-skip"],
    ["option out of range", msg([{ id: "q1", option: 2 }]), "bad-option"],
    ["option not an integer", msg([{ id: "q1", option: 0.5 }]), "bad-option"],
    ["option for a question without options", msg([{ id: "q3", option: 0 }]), "bad-option"],
    ["text not a string", msg([{ id: "q1", text: 42 }]), "bad-text"],
    ["empty text and no option", msg([{ id: "q1", text: "   " }]), "empty-answer"],
    ["text too long", msg([{ id: "q1", text: "x".repeat(MAX_ANSWER_CHARS + 1) }]), "text-too-long"],
  ])("rejects %s", (_name, raw, reason) => {
    expect(parse(raw)).toEqual({ ok: false, reason });
  });

  it("rejects the whole message when one entry is bad", () => {
    expect(parse(msg([{ id: "q1", text: "fine" }, { id: "q2", option: 9 }]))).toEqual({ ok: false, reason: "bad-option" });
  });

  it("rejects a question that is already answered or skipped", () => {
    const closed = [q("q1", { answer: { text: "x", answeredAt: "t" } }), q("q2", { skippedAt: "t" })];
    expect(parse(msg([{ id: "q1", text: "again" }]), closed)).toEqual({ ok: false, reason: "unknown-or-closed-id" });
    expect(parse(msg([{ id: "q2", text: "again" }]), closed)).toEqual({ ok: false, reason: "unknown-or-closed-id" });
  });

  it("never puts answer text into the reason", () => {
    const secret = "x".repeat(MAX_ANSWER_CHARS + 1);
    const res = parse(msg([{ id: "q1", text: secret }]));
    expect(JSON.stringify(res)).not.toContain("xxx");
  });
});

describe("answerEvent and qaFrom", () => {
  it("builds a follow-up event with the same id and payload, and Q&A uses the latest state", () => {
    const [q1, q2, q3] = open;
    const now = "2026-11-26T10:05:00.000Z";
    const answered = answerEvent(q1, { id: "q1", text: "the admin login", option: 0 }, now);
    const skipped = answerEvent(q2, { id: "q2", skip: true }, now);
    expect(answered).toMatchObject({ id: "q1", draftId: "d1", reviewId: "r1", ts: now, answer: { text: "the admin login", option: 0, answeredAt: now } });
    expect(answered).not.toHaveProperty("seq");
    expect(skipped).toMatchObject({ id: "q2", skippedAt: now });
    expect(skipped).not.toHaveProperty("answer");

    const latest = [answered, skipped, q3].map((e, i) => ({ ...e, schemaVersion: SCHEMA_VERSION, seq: 100 + i }) as Event<Question>);
    expect(qaFrom(latest)).toEqual([
      { question: "question q1", answer: "the admin login" },
      { question: "question q2", answer: SKIPPED_ANSWER },
    ]);
  });
});
