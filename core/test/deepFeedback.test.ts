import { describe, expect, it, vi } from "vitest";
import {
  deepFeedback,
  loadDeepSession,
  NO_INSTRUCTION_CONTROL_GAP,
  SCHEMA_VERSION,
  type ContextSource,
  type DeepFeedbackDeps,
  type DeepReviewRecord,
  type Event,
  type EventInput,
  type InstructionLoader,
  type ModelCapabilities,
  type ModelRequest,
  type Question,
  type Repository,
} from "../src/index";

class MemoryRepo<T> implements Repository<T> {
  events: Array<Event<T>> = [];
  async append(e: EventInput<T>): Promise<Event<T>> {
    const event = { ...e, schemaVersion: SCHEMA_VERSION, seq: this.events.length + 1 } as Event<T>;
    this.events.push(event);
    return event;
  }
  async list() {
    return { events: this.events, skipped: 0 };
  }
  async byDraft(id: string) {
    return this.events.filter((e) => (e as { draftId?: string }).draftId === id);
  }
  async bySession(id: string) {
    return this.events.filter((e) => (e as { sessionId?: string }).sessionId === id);
  }
}

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  structuredOutput: true,
  thinkingEffort: true,
  maxContextTokens: 200_000,
  cost: { inputPerMTok: 0, outputPerMTok: 0 },
  supportsInstructionFiles: true,
  ...over,
});

const reply = (body: object) => JSON.stringify({ issues: [], questions: [], assumptions: [], contextGaps: [], ...body });

const VAGUE = reply({
  issues: [{ quote: "fix the login", problem: "No target", suggestion: "Name the page" }],
  questions: [
    { question: "Which login page?", why: "Several exist", options: ["admin", "customer"] },
    { question: "What does broken mean?", why: "No symptom", options: [] },
  ],
  assumptions: ["The bug is in the web app"],
  contextGaps: ["No error message given"],
});

function setup(opts: { replies?: Array<string | ((req: ModelRequest) => string)>; caps?: Partial<ModelCapabilities>; sources?: ContextSource[]; instructions?: InstructionLoader } = {}) {
  const requests: ModelRequest[] = [];
  const replies = [...(opts.replies ?? [reply({})])];
  let n = 0;
  const reviews = new MemoryRepo<DeepReviewRecord>();
  const questions = new MemoryRepo<Question>();
  const deps: DeepFeedbackDeps = {
    provider: {
      capabilities: caps(opts.caps),
      validateProfile: () => ({ ok: true }),
      complete: vi.fn(async (req: ModelRequest) => {
        requests.push(req);
        const r = replies.length > 1 ? replies.shift()! : replies[0];
        return { text: typeof r === "function" ? r(req) : r, inputTokens: 10, outputTokens: 5, costUsd: 0.001 };
      }),
    },
    model: "sonnet",
    clock: { now: () => 1_700_000_000_000 },
    ids: () => `id${++n}`,
    reviews,
    questions,
    sources: () => opts.sources ?? [],
    redact: (text) => ({ text, count: 0 }),
    instructions: opts.instructions,
  };
  return { deps, requests, reviews, questions };
}

const input = { draftId: "d1", draft: "fix the login", folders: ["file:///w"] };

describe("deepFeedback", () => {
  it("clear prompt: one call, empty findings, persisted with manifest and prompt version", async () => {
    const { deps, requests, reviews, questions } = setup();
    const res = await deepFeedback(input, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(requests).toHaveLength(1);
    expect(res.review.issues).toEqual([]);
    expect(res.review.promptVersion).toBe("deep-v1");
    expect(res.review.contextManifest.sources[0].source).toBe("draft");
    expect(reviews.events).toHaveLength(1);
    expect(reviews.events[0]).toMatchObject({ id: res.reviewId, draftId: "d1", ts: "2023-11-14T22:13:20.000Z" });
    expect(questions.events).toHaveLength(0);
  });

  it("vague prompt: issues, assumptions and gaps kept, each question persisted", async () => {
    const { deps, questions } = setup({ replies: [VAGUE] });
    const res = await deepFeedback(input, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.review.issues[0].quote).toBe("fix the login");
    expect(res.review.assumptions).toEqual(["The bug is in the web app"]);
    expect(res.review.contextGaps).toContain("No error message given");
    expect(questions.events.map((q) => [q.question, q.reviewId, q.draftId])).toEqual([
      ["Which login page?", res.reviewId, "d1"],
      ["What does broken mean?", res.reviewId, "d1"],
    ]);
  });

  it("missing context: a referenced file that does not exist becomes a context gap", async () => {
    const missing: ContextSource = {
      id: "prompt-files",
      priority: 80,
      collect: async () => ({ fragments: [], omittedReason: "empty", details: { files: 0, missing: 1, ambiguous: 0, excluded: 0 } }),
    };
    const { deps, requests } = setup({ sources: [missing] });
    const res = await deepFeedback({ ...input, draft: "update @core/src/gate.ts" }, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.review.contextGaps).toContain("1 referenced file was not found in the workspace");
    expect(requests[0].user).toContain("missing=1");
  });

  it("answers change the next deep review", async () => {
    const second = (req: ModelRequest) =>
      req.user.includes("A: the admin login") ? reply({ assumptions: ["admin login"] }) : reply({ assumptions: ["unknown page"] });
    const { deps, requests, questions } = setup({ replies: [VAGUE, second] });
    await deepFeedback(input, deps);
    const asked = questions.events.find((q) => q.question === "Which login page?")!;
    await questions.append({ ...asked, answer: { text: "the admin login", option: 0, answeredAt: "2023-11-14T22:14:00.000Z" } });

    const res = await deepFeedback(input, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(requests[1].user).toContain("<qa>\nQ: Which login page?\nA: the admin login\n</qa>");
    expect(requests[1].user).not.toContain("What does broken mean?"); // unanswered questions are not Q&A
    expect(res.review.assumptions).toEqual(["admin login"]);
  });

  it("stops before the model call when the bundle exceeds the budget", async () => {
    const { deps } = setup({ caps: { maxContextTokens: 3 } });
    const res = await deepFeedback(input, deps);
    expect(res).toMatchObject({ ok: false, error: { code: "context-too-large", action: "reduce-context" } });
    expect(deps.provider.complete).not.toHaveBeenCalled();
  });

  it("skips the instruction loader and reports a gap when the provider cannot control auto-load", async () => {
    const load = vi.fn(async () => ({ text: "x", files: [] }));
    const { deps } = setup({ caps: { supportsInstructionFiles: false }, instructions: { load } });
    const res = await deepFeedback(input, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(load).not.toHaveBeenCalled();
    expect(res.review.contextGaps).toContain(NO_INSTRUCTION_CONTROL_GAP);
  });

  it("puts loaded instructions in the system prompt and their files in the manifest", async () => {
    const load = vi.fn(async () => ({
      text: "<project-instructions>use pnpm</project-instructions>",
      files: [{ displayPath: "AGENTS.md", relativePath: "AGENTS.md", folder: "file:///w", bytes: 40, tokens: 10, included: true, truncated: false, redactions: 0 }],
    }));
    const { deps, requests } = setup({ instructions: { load } });
    const res = await deepFeedback(input, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(load).toHaveBeenCalledWith(["file:///w"], "fix the login", { instructionFileNames: [] });
    expect(requests[0].system).toContain("use pnpm");
    expect(res.review.contextManifest.sources.map((s) => s.source)).toContain("instructions:AGENTS.md");
  });

  it("never sends a raw @ mention to the CLI and keeps quotes that contain one (#56)", async () => {
    const { deps, requests } = setup({
      replies: [(req) => reply({ issues: [{ quote: req.user.match(/@​\.env/)![0], problem: "secret file", suggestion: "remove it" }] })],
    });
    const res = await deepFeedback({ ...input, draft: "print @.env" }, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(requests[0].user).not.toMatch(/@(?!​)/);
    expect(res.review.issues[0].quote).toBe("@.env");
  });

  it("returns invalid-response and stores nothing when the reply is not a review", async () => {
    const { deps, reviews } = setup({ replies: ["sorry, I cannot help"] });
    const res = await deepFeedback(input, deps);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid-response" } });
    expect(reviews.events).toHaveLength(0);
  });

  it("stores the session slice the model saw", async () => {
    const session: ContextSource = {
      id: "session-slice",
      priority: 85,
      collect: async () => ({
        fragments: [{ source: "session-slice", priority: 85, content: "turn 1: npm test failed", tokens: 6, provenance: { kind: "session", truncated: false, chars: 23, redactions: 0 } }],
      }),
    };
    const { deps, requests } = setup({ sources: [session] });
    const res = await deepFeedback({ ...input, sessionId: "agent-1" }, deps);
    if (!res.ok) throw new Error(res.error.code);
    expect(requests[0].user).toContain("<session>\nturn 1: npm test failed\n</session>");
    expect(res.review.sessionSlice).toEqual({ content: "turn 1: npm test failed", tokens: 6, truncated: false });
    expect(res.review.sessionId).toBe("agent-1");
  });
});

describe("loadDeepSession", () => {
  it("returns the latest review and the latest state of each question in asking order", async () => {
    const { deps } = setup({ replies: [VAGUE] });
    await deepFeedback(input, deps);
    const [first] = (deps.questions as MemoryRepo<Question>).events;
    await deps.questions.append({ ...first, answer: { text: "admin", answeredAt: "t" } });
    const s = await loadDeepSession("d1", deps);
    expect(s.latest?.draftId).toBe("d1");
    expect(s.questions.map((q) => [q.question, q.answer?.text])).toEqual([
      ["Which login page?", "admin"],
      ["What does broken mean?", undefined],
    ]);
  });
});

describe("manifestGaps", () => {
  const entry = (source: string, over: object) => ({ source, chars: 0, tokens: 0, included: false, truncated: false, redactions: 0, ...over });
  it("names sources in plain words, skips empty ones and explains excluded files once", async () => {
    const { manifestGaps } = await import("../src/index");
    const gaps = manifestGaps(
      {
        sources: [
          entry("session-slice", { omittedReason: "empty" }),
          entry("git-diff", { omittedReason: "budget" }),
          entry("symbols", { included: true, truncated: true, tokens: 5 }),
          entry("prompt-files", { omittedReason: "excluded", details: { excluded: 2 } }),
        ],
        totalTokens: 5,
        budget: 5,
      },
      true,
    );
    expect(gaps).toEqual([
      "Left out: the uncommitted changes (the context budget was full)",
      "Cut to fit the context budget: the code outline",
      "2 referenced files were left out by the privacy settings",
    ]);
  });
});
