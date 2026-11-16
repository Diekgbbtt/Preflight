import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlRepository, SCHEMA_VERSION, migrate, type Event } from "../src/repository";

const at = (v: number, seq: number, id = "d1"): Event<{ text: string }> =>
  ({ schemaVersion: v, seq, id, ts: "2026-01-01T00:00:00.000Z", text: `v${v}` });

let dir: string | null = null;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

async function tempFile(name = "drafts.jsonl"): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-repo-"));
  return path.join(dir, name);
}

describe("JsonlRepository", () => {
  it("returns empty results for a missing file", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    await expect(repo.list()).resolves.toEqual({ events: [], skipped: 0 });
  });

  it("skips and counts corrupt complete lines but returns the valid events", async () => {
    const file = await tempFile();
    const good = (seq: number, id: string) =>
      JSON.stringify({ schemaVersion: 1, seq, id, ts: "2026-01-01T00:00:00.000Z", text: id });
    await fs.writeFile(file, [good(1, "a"), "{not json", good(3, "c"), ""].join("\n"), "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a", "c"]);
    expect(skipped).toBe(1);
  });

  it("ignores a trailing partial line and does not count it as skipped", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, good + "\n" + `{"schemaVersion":1,"seq":2,"id":"b"`, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(skipped).toBe(0);
  });

  it("terminates and adopts a trailing partial line that parses as a valid envelope on the next append", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    const partial = JSON.stringify({ schemaVersion: 1, seq: 2, id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    await fs.writeFile(file, good + "\n" + partial, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "c", ts: "2026-01-01T00:00:02.000Z", text: "c" });
    expect(stored.seq).toBe(3);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(skipped).toBe(0);
    const content = await fs.readFile(file, "utf8");
    const lines = content.split("\n");
    expect(lines).toEqual([good, partial, JSON.stringify(stored), ""]);
    expect(JSON.parse(lines[lines.length - 2])).toMatchObject({ seq: 3 });
  });

  it("terminates a corrupt trailing partial line, counts it skipped, and appends above any numeric seq", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, good + "\n" + `{"schemaVersion":1,"seq":2,"id":"b"`, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "c", ts: "2026-01-01T00:00:02.000Z", text: "c" });
    expect(stored.seq).toBe(2);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(skipped).toBe(1);
  });

  it("recovers from a duplicate seq after a crash: max numeric seq raises the next append", async () => {
    const file = await tempFile();
    const good = (seq: number, id: string) =>
      JSON.stringify({ schemaVersion: 1, seq, id, ts: "2026-01-01T00:00:00.000Z", text: id });
    const partial = JSON.stringify({ schemaVersion: 1, seq: 2, id: "b", ts: "2026-01-01T00:00:00.000Z", text: "b" });
    await fs.writeFile(file, [good(1, "a"), good(2, "a2"), partial].join("\n"), "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "c", ts: "2026-01-01T00:00:01.000Z", text: "c" });
    expect(stored.seq).toBe(3);
    const { events } = await repo.list();
    expect(events.filter((e) => e.seq === 2).length).toBe(2);
  });

  it("reloads every event in new repository instances on the same paths", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-reload-"));
    dir = base;
    const drafts = new JsonlRepository<{ text: string }>(path.join(base, "drafts.jsonl"));
    const questions = new JsonlRepository<Record<string, unknown>>(path.join(base, "questions.jsonl"));
    const reviews = new JsonlRepository<Record<string, unknown>>(path.join(base, "reviews.jsonl"));
    const sends = new JsonlRepository<Record<string, unknown>>(path.join(base, "sends.jsonl"));
    await drafts.append({ id: "d1", ts: "2026-01-01T00:00:00.000Z", text: "draft" });
    await questions.append({ id: "q1", ts: "2026-01-01T00:00:01.000Z", draftId: "d1", question: "?" });
    await reviews.append({ id: "r1", ts: "2026-01-01T00:00:02.000Z", draftId: "d1", score: null });
    await sends.append({
      id: "s1", ts: "2026-01-01T00:00:03.000Z", draftId: "d1", folderUri: "file:///x",
      text: "sent", promptHash: "abc", target: "terminal",
    });
    const drafts2 = new JsonlRepository<{ text: string }>(path.join(base, "drafts.jsonl"));
    const questions2 = new JsonlRepository<Record<string, unknown>>(path.join(base, "questions.jsonl"));
    const reviews2 = new JsonlRepository<Record<string, unknown>>(path.join(base, "reviews.jsonl"));
    const sends2 = new JsonlRepository<Record<string, unknown>>(path.join(base, "sends.jsonl"));
    expect((await drafts2.list()).events.map((e) => e.seq)).toEqual([1]);
    expect((await questions2.list()).events.map((e) => e.seq)).toEqual([1]);
    expect((await reviews2.list()).events.map((e) => e.seq)).toEqual([1]);
    expect((await sends2.list()).events.map((e) => e.seq)).toEqual([1]);
  });
});

describe("migrate", () => {
  it("skips and counts events with an unknown future schema version", () => {
    const result = migrate([at(2, 1)]);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts an older event when no step is registered", () => {
    const result = migrate([at(0, 1)]);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts a step that does not increase the version", () => {
    const steps = { 0: (event: Event<unknown>): Event<unknown> => ({ ...event, schemaVersion: 0 }) };
    const result = migrate([at(0, 1)], steps);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("skips and counts a step that returns null", () => {
    const steps = { 0: (): Event<unknown> | null => null };
    const result = migrate([at(0, 1)], steps);
    expect(result.events).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("does not mutate the input array or the input events", () => {
    const input = [at(0, 1)];
    const snapshot = input.map((e) => ({ ...e }));
    const steps = { 0: (event: Event<unknown>): Event<unknown> => ({ ...event, schemaVersion: 1 }) };
    const result = migrate(input, steps);
    expect(input).toEqual(snapshot);
    expect(input[0] === result.events[0]).toBe(false);
    expect(migrate(input).skipped).toBe(1);
  });

  it("passes through events already at the current schema version", () => {
    const events = [at(1, 1)];
    const result = migrate(events);
    expect(result.skipped).toBe(0);
    expect(result.events).toEqual(events);
  });

  it("migrates an older event with a registered step and is idempotent", () => {
    const step = (event: Event<unknown>): Event<unknown> => ({
      ...event,
      schemaVersion: SCHEMA_VERSION,
    });
    const result = migrate([at(0, 1)], { 0: step });
    expect(result.events.map((e) => e.schemaVersion)).toEqual([1]);
    expect(result.skipped).toBe(0);
    const again = migrate(result.events);
    expect(again.events).toEqual(result.events);
    expect(again.skipped).toBe(0);
  });
});
