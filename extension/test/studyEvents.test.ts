import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { JsonlRepository } from "../src/repository";
import { migrateStudyLog, StudyRecorder, type StudyData } from "../src/studyEvents";

it("appends linked send, score, review, usage and outcome observations with injected ids/time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "preflight-study-"));
  try {
    const file = path.join(dir, "study.jsonl");
    const repo = new JsonlRepository<StudyData>(file);
    let id = 0;
    const recorder = new StudyRecorder(repo, { now: () => 1000 }, () => `event-${++id}`);
    const links = { draftId: "d", sendId: "s", sessionId: "session" };
    await Promise.all([
      recorder.write("score", { ...links, reviewId: "r" }, { score: 85, scoreSource: "quick" }),
      recorder.write("review", { ...links, reviewId: "r" }, { latencyMs: 42 }),
      recorder.write("send", links, { finalScore: 85, preflightInputTokens: 20 }),
      recorder.write("agent-usage", links, { agentInputTokens: 100 }),
      recorder.write("outcome", links, { outcome: "passed" }),
    ]);
    const stored = (await repo.byDraft("d"));
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map(e => e.sendId))).toEqual(new Set(["s"]));
    expect(stored.map(e => e.id)).toEqual(["event-1", "event-2", "event-3", "event-4", "event-5"]);
    expect(stored.every(e => e.ts === "1970-01-01T00:00:01.000Z" && e.studySchemaVersion === 2)).toBe(true);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("migrates legacy symbolic scores without mislabeling them as model measurements", () => {
  const text = JSON.stringify({ event: "send", ts: "2026-11-18T00:00:00Z", prompt: "hello", firstScore: 100, finalScore: 95, preflightInputTokens: 20 }) + "\n{broken\n";
  const result = migrateStudyLog(text);
  expect(result.skipped).toBe(1);
  expect(result.events[0]).toMatchObject({ id: "legacy-1", sendId: "legacy-1", studySchemaVersion: 2, firstScore: null, finalScore: null, legacyRuleScore: 95, scoreAvailable: false, text: "hello", preflightInputTokens: 20 });
  expect(migrateStudyLog(text)).toEqual(result);
});
