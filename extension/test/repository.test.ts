import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event } from "@prompt-preflight/core";
import { SCHEMA_VERSION, migrate } from "@prompt-preflight/core";
import { JsonlRepository } from "../src/repository";

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

  it("matches drafts.jsonl byDraft on the envelope id and other files on the payload draftId", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-idx-"));
    dir = base;
    const drafts = new JsonlRepository<{ text: string }>(path.join(base, "drafts.jsonl"));
    await drafts.append({ id: "d1", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await drafts.append({ id: "d2", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    expect((await drafts.byDraft("d1")).map((e) => e.id)).toEqual(["d1"]);
    expect(await drafts.byDraft("nope")).toEqual([]);

    const sends = new JsonlRepository<{ draftId: string; promptHash: string }>(path.join(base, "sends.jsonl"));
    await sends.append({ id: "s1", ts: "2026-01-01T00:00:02.000Z", draftId: "d1", promptHash: "h1" });
    await sends.append({ id: "s2", ts: "2026-01-01T00:00:03.000Z", draftId: "d2", promptHash: "h2" });
    expect((await sends.byDraft("d1")).map((e) => e.id)).toEqual(["s1"]);
    expect(await sends.byDraft("unknown")).toEqual([]);
  });

  it("indexes bySession on the payload sessionId and skips a missing session id", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-idx-"));
    dir = base;
    const sends = new JsonlRepository<{ draftId: string; promptHash: string; sessionId?: string }>(
      path.join(base, "sends.jsonl"),
    );
    await sends.append({ id: "s1", ts: "2026-01-01T00:00:00.000Z", draftId: "d1", promptHash: "h", sessionId: "sess1" });
    await sends.append({ id: "s2", ts: "2026-01-01T00:00:01.000Z", draftId: "d1", promptHash: "h" });
    expect((await sends.bySession("sess1")).map((e) => e.id)).toEqual(["s1"]);
    expect(await sends.bySession("sessX")).toEqual([]);

    const drafts = new JsonlRepository<{ text: string }>(path.join(base, "drafts.jsonl"));
    await drafts.append({ id: "d1", ts: "2026-01-01T00:00:02.000Z", text: "a" });
    expect(await drafts.bySession("sess1")).toEqual([]);
  });

  it("preserves both versions of a duplicated id, ordered by seq", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    await repo.append({ id: "d1", ts: "2026-01-01T00:00:00.000Z", text: "v1" });
    await repo.append({ id: "d1", ts: "2026-01-01T00:00:01.000Z", text: "v2" });
    const { events } = await repo.list();
    expect(events.map((e) => [e.seq, e.text])).toEqual([[1, "v1"], [2, "v2"]]);
    expect((await repo.byDraft("d1")).length).toBe(2);
  });

  it("grows the file by exactly the new line's bytes and preserves the original prefix", async () => {
    const file = await tempFile();
    const prefix = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" }) + "\n";
    await fs.writeFile(file, prefix, "utf8");
    const before = await fs.stat(file);
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    const line = JSON.stringify(stored) + "\n";
    const after = await fs.stat(file);
    expect(Number(after.size) - Number(before.size)).toBe(Buffer.byteLength(line, "utf8"));
    const content = await fs.readFile(file, "utf8");
    expect(content).toBe(prefix + line);
  });

  it("serializes two concurrent appends and a read queued behind them", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    const [first, second, list] = await Promise.all([
      repo.append({ id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" }),
      repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" }),
      repo.list(),
    ]);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(list.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("preserves unicode and newline characters inside string values on one line", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    const text = "héllo 🌍\nsecond line";
    await repo.append({ id: "d1", ts: "2026-01-01T00:00:00.000Z", text });
    const { events, skipped } = await repo.list();
    expect(skipped).toBe(0);
    expect(events[0]?.text).toBe(text);
    const content = await fs.readFile(file, "utf8");
    expect(content.split("\n").length).toBe(2);
    expect(content).toContain("\\n");
  });

  it("clears the file, reports valid events, and restarts seq at 1", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, good + "\n{corrupt\n" + `{"schemaVersion":1,"seq":2,"id":"b"`, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const result = await repo.clear();
    expect(result.deleted).toBe(1);
    expect(await fs.stat(file).then(() => true, () => false)).toBe(false);
    expect(await repo.list()).toEqual({ events: [], skipped: 0 });
    const stored = await repo.append({ id: "c", ts: "2026-01-01T00:00:01.000Z", text: "c" });
    expect(stored.seq).toBe(1);
  });

  it("returns deleted 0 for a missing file", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    await expect(repo.clear()).resolves.toEqual({ deleted: 0 });
  });

  it("waits for a queued append during clear and rejects appends started after clear begins", async () => {
    const file = await tempFile();
    const repo = new JsonlRepository<{ text: string }>(file);
    await repo.append({ id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });

    let resolveAppend: ((value: void) => void) | undefined;
    const gate = new Promise<void>((resolve) => (resolveAppend = resolve));
    const queued = repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });

    const clearing = repo.clear();
    const rejected = repo.append({ id: "c", ts: "2026-01-01T00:00:02.000Z", text: "c" });
    await expect(rejected).rejects.toThrow("repository is clearing");
    resolveAppend?.();
    const result = await clearing;
    expect(result.deleted).toBe(2);
    await queued;
    expect(await repo.list()).toEqual({ events: [], skipped: 0 });
  });

  it("rejects with the fs error when the directory is read-only", async () => {
    if (process.getuid?.() === 0) return;
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-ro-"));
    dir = base;
    const file = path.join(base, "sub", "drafts.jsonl");
    await fs.mkdir(path.dirname(file));
    await fs.chmod(path.dirname(file), 0o555);
    try {
      const repo = new JsonlRepository<{ text: string }>(file);
      await expect(repo.append({ id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" })).rejects.toThrow(/EACCES|EROFS|EPERM/);
    } finally {
      await fs.chmod(path.dirname(file), 0o755);
    }
  });

  it("keeps a stored SendRecord with a missing promptHash or sessionId and does not index a missing session", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-send-"));
    dir = base;
    const sends = new JsonlRepository<Record<string, unknown>>(path.join(base, "sends.jsonl"));
    await sends.append({ id: "s1", ts: "2026-01-01T00:00:00.000Z", draftId: "d1", folderUri: "file:///x", text: "p", target: "terminal" });
    const { events, skipped } = await sends.list();
    expect(skipped).toBe(0);
    expect(events).toHaveLength(1);
    expect(await sends.bySession("missing")).toEqual([]);
  });

  it("orders events ascending by seq after reload, not file order", async () => {
    const file = await tempFile();
    const b = JSON.stringify({ schemaVersion: 1, seq: 2, id: "b", ts: "2026-01-01T00:00:00.000Z", text: "b" });
    const a = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, [b, a, ""].join("\n"), "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(skipped).toBe(0);
    expect(events.map((e) => [e.seq, e.id])).toEqual([[1, "a"], [2, "b"]]);
  });

  it("keeps file order for a stable tie on equal seq after reload", async () => {
    const file = await tempFile();
    const b = JSON.stringify({ schemaVersion: 1, seq: 2, id: "b", ts: "2026-01-01T00:00:00.000Z", text: "b" });
    const c = JSON.stringify({ schemaVersion: 1, seq: 2, id: "c", ts: "2026-01-01T00:00:00.000Z", text: "c" });
    const a = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, [b, c, a, ""].join("\n"), "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events } = await repo.list();
    expect(events.map((e) => [e.seq, e.id])).toEqual([[1, "a"], [2, "b"], [2, "c"]]);
  });

  it("returns byDraft results ordered by seq for out-of-order file positions", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-idx-"));
    dir = base;
    const line = (seq: number, id: string, draftId: string) =>
      JSON.stringify({ schemaVersion: 1, seq, id, ts: "2026-01-01T00:00:00.000Z", draftId, promptHash: "h" });
    await fs.writeFile(path.join(base, "sends.jsonl"), [line(4, "s4", "d1"), line(2, "s2", "d2"), line(1, "s1", "d1"), line(3, "s3", "d1"), ""].join("\n"), "utf8");
    const sends = new JsonlRepository<{ draftId: string; promptHash: string }>(path.join(base, "sends.jsonl"));
    expect((await sends.byDraft("d1")).map((e) => e.id)).toEqual(["s1", "s3", "s4"]);
  });

  it("returns bySession results ordered by seq for out-of-order file positions", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-idx-"));
    dir = base;
    const line = (seq: number, id: string, sessionId: string) =>
      JSON.stringify({ schemaVersion: 1, seq, id, ts: "2026-01-01T00:00:00.000Z", draftId: "d1", promptHash: "h", sessionId });
    await fs.writeFile(path.join(base, "sends.jsonl"), [line(3, "s3", "sess1"), line(1, "s1", "sess1"), line(2, "s2", "sess2"), ""].join("\n"), "utf8");
    const sends = new JsonlRepository<{ draftId: string; promptHash: string; sessionId?: string }>(
      path.join(base, "sends.jsonl"),
    );
    expect((await sends.bySession("sess1")).map((e) => e.id)).toEqual(["s1", "s3"]);
  });

  it("raises the next seq from a valid-looking trailing partial line with a future schema version", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    const partial = JSON.stringify({ schemaVersion: 2, seq: 7, id: "x", ts: "2026-01-01T00:00:00.000Z", data: true });
    await fs.writeFile(file, good + "\n" + partial, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    expect(stored.seq).toBe(8);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("raises the next seq from a trailing partial line that parses but fails envelope validation", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    const partial = JSON.stringify({ seq: 7, id: "x" });
    await fs.writeFile(file, good + "\n" + partial, "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const stored = await repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    expect(stored.seq).toBe(8);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(skipped).toBe(1);
  });

  it("skips and counts a complete line with seq 0 and does not raise the next append's seq", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    const zero = JSON.stringify({ schemaVersion: 1, seq: 0, id: "z", ts: "2026-01-01T00:00:00.000Z", text: "z" });
    await fs.writeFile(file, good + "\n" + zero + "\n", "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a"]);
    expect(skipped).toBe(1);
    const stored = await repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    expect(stored.seq).toBe(2);
  });

  it("skips and counts a complete line with a negative schema version", async () => {
    const file = await tempFile();
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    const negative = JSON.stringify({ schemaVersion: -1, seq: 2, id: "n", ts: "2026-01-01T00:00:00.000Z", text: "n" });
    await fs.writeFile(file, good + "\n" + negative + "\n", "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a"]);
    expect(skipped).toBe(1);
  });

  it("skips and counts an event with an unknown future schema version; its seq still raises the next append", async () => {
    const file = await tempFile();
    const v2 = JSON.stringify({ schemaVersion: 2, seq: 4, id: "x", ts: "2026-01-01T00:00:00.000Z", data: true });
    const good = JSON.stringify({ schemaVersion: 1, seq: 1, id: "a", ts: "2026-01-01T00:00:00.000Z", text: "a" });
    await fs.writeFile(file, good + "\n" + v2 + "\n", "utf8");
    const repo = new JsonlRepository<{ text: string }>(file);
    const { events, skipped } = await repo.list();
    expect(events.map((e) => e.id)).toEqual(["a"]);
    expect(skipped).toBe(1);
    const stored = await repo.append({ id: "b", ts: "2026-01-01T00:00:01.000Z", text: "b" });
    expect(stored.seq).toBe(5);
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
