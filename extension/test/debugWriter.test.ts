import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearTraceFiles, JsonlTraceWriter, listTraceFiles } from "../src/debug/writer";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-debug-writer-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("JsonlTraceWriter", () => {
  it("writes JSONL and rotates at the configured size", async () => {
    const dir = await tempDir();
    const rotated: string[] = [];
    const writer = new JsonlTraceWriter({
      dir,
      maxSize: "1K",
      maxFiles: 3,
      onRotate: (file) => rotated.push(file),
    });
    const line = "x".repeat(400);
    for (let i = 0; i < 5; i++) {
      await writer.write({ schemaVersion: 1, recordType: "log", body: `record-${i}`, pad: line });
    }
    await writer.close();
    const files = await listTraceFiles(dir);
    expect(files).toContain(path.join(dir, "llm-trace.jsonl"));
    expect(files.some((file) => /llm-trace\.\d+\.jsonl$/.test(file))).toBe(true);
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    const current = await fs.readFile(path.join(dir, "llm-trace.jsonl"), "utf8");
    expect(current).toContain('"recordType":"log"');
    const stat = await fs.stat(path.join(dir, "llm-trace.jsonl"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clears the current file, rotations and history", async () => {
    const dir = await tempDir();
    const writer = new JsonlTraceWriter({ dir });
    await writer.write({ schemaVersion: 1, recordType: "log", body: "one" });
    await writer.close();
    expect(await listTraceFiles(dir)).not.toHaveLength(0);
    await clearTraceFiles(dir);
    expect(await listTraceFiles(dir)).toEqual([]);
  });
});
