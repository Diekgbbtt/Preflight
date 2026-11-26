import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deepFeedback, loadDeepSession, type DeepFeedbackDeps, type DeepReviewRecord, type ModelRequest, type Question } from "@prompt-preflight/core";
import { JsonlRepository } from "../src/repository";

let dir: string;
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

const repos = () => ({
  reviews: new JsonlRepository<DeepReviewRecord>(path.join(dir, "reviews.jsonl")),
  questions: new JsonlRepository<Question>(path.join(dir, "questions.jsonl")),
});

describe("deep feedback session on disk", () => {
  it("replays the review and the answers after a reload and feeds them into the next round", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-deep-"));
    const requests: ModelRequest[] = [];
    let n = 0;
    const deps = (r: ReturnType<typeof repos>): DeepFeedbackDeps => ({
      ...r,
      provider: {
        capabilities: { structuredOutput: true, thinkingEffort: true, maxContextTokens: 200_000, cost: { inputPerMTok: 0, outputPerMTok: 0 }, supportsInstructionFiles: true },
        validateProfile: () => ({ ok: true }),
        complete: async (req) => {
          requests.push(req);
          return {
            text: JSON.stringify({ issues: [], questions: [{ question: "Which page?", why: "two exist", options: ["admin"] }], assumptions: [], contextGaps: [] }),
            inputTokens: 1,
            outputTokens: 1,
            costUsd: 0,
          };
        },
      },
      model: "sonnet",
      clock: { now: () => 0 },
      ids: () => `id${++n}`,
      sources: () => [],
      redact: (text) => ({ text, count: 0 }),
    });
    const input = { draftId: "d1", draft: "fix the login", folders: [] };

    const before = repos();
    const first = await deepFeedback(input, deps(before));
    expect(first.ok).toBe(true);
    const [asked] = (await before.questions.byDraft("d1"));
    await before.questions.append({ ...asked, answer: { text: "admin", option: 0, answeredAt: "1970-01-01T00:00:01.000Z" } });

    // Reload: fresh repository instances read the same files.
    const after = repos();
    const session = await loadDeepSession("d1", after);
    expect(session.latest?.id).toBe(first.ok ? first.reviewId : "");
    expect(session.latest?.contextManifest.sources[0].source).toBe("draft");
    expect(session.questions.map((q) => q.answer?.text)).toEqual(["admin"]);

    await deepFeedback(input, deps(after));
    expect(requests[1].user).toContain("Q: Which page?\nA: admin");
  });
});
