import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { accountClaudeUsage, readAgentUsage } from "../src/agentUsage";
const row = (id: string, input: number, output: number) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } });
it("sums transcript counters once per assistant id and keeps Preflight/context tokens out", () => {
  const result = accountClaudeUsage([row("a", 10, 1), row("a", 10, 8), row("b", 20, 9), "{broken", JSON.stringify({ type: "user", tokens: 999999 }), JSON.stringify({ total_cost_usd: 0.03 })]);
  expect(result).toEqual({ agentInputTokens: 30, agentOutputTokens: 17, agentCacheReadTokens: 200, agentCacheCreationTokens: 100, agentCostUsd: 0.03, usageAvailable: true });
});
it("does not invent cost or usage for unsupported data", () => {
  expect(accountClaudeUsage(["{}"])).toMatchObject({ usageAvailable: false, agentCostUsd: null });
});
it("streams a transcript without exposing text and tolerates corrupt rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "preflight-usage-"));
  try {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, [row("a", 3, 4), row("a", 3, 7), "{partial"].join("\n"));
    const usage = await readAgentUsage(file);
    expect(usage.agentOutputTokens).toBe(7); expect(usage.agentInputTokens).toBe(3);
    expect(usage).not.toHaveProperty("text"); expect(usage.agentCostUsd).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
