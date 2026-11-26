import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

export interface AgentUsage {
  agentInputTokens: number;
  agentOutputTokens: number;
  agentCacheReadTokens: number;
  agentCacheCreationTokens: number;
  agentCostUsd: number | null;
  usageAvailable: boolean;
}
const numeric = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;

/** Claude assistant snapshots share a message id: keep the latest usage, never sum stream updates. */
export function accountClaudeUsage(lines: Iterable<string>): AgentUsage {
  const messages = new Map<string, Record<string, unknown>>();
  let cost: number | null = null;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.type === "assistant" && typeof row.message?.id === "string" && row.message.usage) {
        messages.set(row.message.id, row.message.usage);
      }
      // Only an explicit session total is a cost observation; do not invent prices.
      if (typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd) && row.total_cost_usd >= 0) cost = row.total_cost_usd;
    } catch { /* partial/corrupt lines have no usage */ }
  }
  const out: AgentUsage = { agentInputTokens: 0, agentOutputTokens: 0, agentCacheReadTokens: 0, agentCacheCreationTokens: 0, agentCostUsd: cost, usageAvailable: messages.size > 0 };
  for (const u of messages.values()) {
    out.agentInputTokens += numeric(u.input_tokens);
    out.agentOutputTokens += numeric(u.output_tokens);
    out.agentCacheReadTokens += numeric(u.cache_read_input_tokens);
    out.agentCacheCreationTokens += numeric(u.cache_creation_input_tokens);
  }
  return out;
}

/** Stream metadata only. No raw transcript is returned or persisted. */
export async function readAgentUsage(file: string): Promise<AgentUsage> {
  await fs.access(file);
  const lines: string[] = [];
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) {
    try {
      const row = JSON.parse(line);
      if (row.type === "assistant" && row.message?.usage) lines.push(JSON.stringify({ type: row.type, message: { id: row.message.id, usage: row.message.usage } }));
      if (typeof row.total_cost_usd === "number") lines.push(JSON.stringify({ total_cost_usd: row.total_cost_usd }));
    } catch { /* ignore corrupt lines */ }
  }
  return accountClaudeUsage(lines);
}
