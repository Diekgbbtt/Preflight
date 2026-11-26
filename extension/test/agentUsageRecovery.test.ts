import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Event, Repository, SendRecord } from "@prompt-preflight/core";
import { AgentUsageRecovery, terminalSessionId, type UsageJob, type UsageLog } from "../src/agentUsageRecovery";
import { JsonlRepository } from "../src/repository";
import { encodeClaudeProjectPath } from "../src/sessionLocator";
import { StudyRecorder, type StudyData } from "../src/studyEvents";

let dir: string;
let folder: string;
let home: string;
let transcript: string;
let enabled: boolean;
let participant: string;
const links = { draftId: "draft-1", sendId: "send-1", sessionId: "session-1" };
const clock = { now: () => 1_000 };
let ids = 0;
function log(): UsageLog {
  const repo = new JsonlRepository<StudyData>(path.join(dir, "study-events-v2.jsonl"));
  const recorder = new StudyRecorder(repo, clock, () => `e-${++ids}`);
  return {
    get enabled() { return enabled; }, get participant() { return participant; },
    getEvents: async () => (await repo.list()).events,
    writeOnce: async (event, links, data, eventId, participant) => {
      if (!enabled) return false;
      if (!(await repo.list()).events.some(e => e.id === eventId)) await recorder.write(event, links, data, participant, eventId);
      return true;
    },
  };
}
const service = (usageLog = log(), jobs?: Repository<UsageJob>) => new AgentUsageRecovery({ storagePath: dir, homeDir: home, log: usageLog, clock, jobs });
async function events() { return (await new JsonlRepository<StudyData>(path.join(dir, "study-events-v2.jsonl")).list()).events; }
async function usage(output = 7) {
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, JSON.stringify({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Private draft should never be persisted by recovery" }], usage: { input_tokens: 20, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 } } }) + "\n");
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "preflight-recovery-"));
  home = path.join(dir, "home"); folder = pathToFileURL(path.join(dir, "workspace")).href;
  transcript = path.join(home, ".claude", "projects", encodeClaudeProjectPath(path.join(dir, "workspace")), "session-1.jsonl");
  enabled = true; participant = "original-participant"; ids = 0;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("recovers exact-session counters after losing the original service and never guesses completion", async () => {
  await service().track(links, folder);
  await usage();
  participant = "new-participant";
  const recovered = service();
  await recovered.recover();
  expect((await events())[0]).toMatchObject({ ...links, participant: "original-participant", agentInputTokens: 20, agentOutputTokens: 7, agentCacheReadTokens: 100, agentCacheCreationTokens: 40, agentCostUsd: null, recovered: true, complete: false });
  expect((await readFile(path.join(dir, "agent-usage-pending.jsonl"), "utf8"))).not.toContain("Private draft");
  expect((await readFile(path.join(dir, "study-events-v2.jsonl"), "utf8"))).not.toContain("Private draft");
  await recovered.recover(); await service().recover();
  expect(await events()).toHaveLength(1);
  await usage(11); await recovered.recover();
  expect((await events()).at(-1)).toMatchObject({ agentOutputTokens: 11, complete: false, observation: "cumulative-snapshot" });
  await recovered.closeSession("session-1");
  expect((await events()).at(-1)).toMatchObject({ agentOutputTokens: 11, complete: true });
  await service().recover(); await recovered.closeSession("session-1");
  expect(await events()).toHaveLength(3);
});

it("retries a transcript that is missing at restart and appears later", async () => {
  await service().track(links, folder);
  const recovery = service();
  await recovery.recover(); await recovery.recover();
  expect(await events()).toHaveLength(1);
  expect((await events())[0]).toMatchObject({ usageAvailable: false, complete: false, reason: "session-not-found" });
  await usage(); await recovery.recover();
  expect((await events()).at(-1)).toMatchObject({ usageAvailable: true, agentOutputTokens: 7, complete: false });
});

it("coalesces concurrent recovery and only rereads a transcript when it changes or closes", async () => {
  await usage();
  const readUsage = vi.fn(async () => ({ agentInputTokens: 20, agentOutputTokens: 7, agentCacheReadTokens: 100,
    agentCacheCreationTokens: 40, agentCostUsd: null, usageAvailable: true }));
  const recovery = new AgentUsageRecovery({ storagePath: dir, homeDir: home, log: log(), clock, readUsage });
  await recovery.track(links, folder);
  await Promise.all([recovery.recover(), recovery.recover()]);
  await recovery.recover();
  expect(readUsage).toHaveBeenCalledTimes(1);
  await usage(11);
  await recovery.recover();
  await recovery.closeSession(links.sessionId);
  expect(readUsage).toHaveBeenCalledTimes(3);
});

it("preserves terminal exit while logging is disabled and completes when opt-in returns", async () => {
  const recovery = service(); await recovery.track(links, folder); await usage();
  enabled = false;
  await recovery.closeSession("session-1"); await recovery.recover();
  expect(await events()).toHaveLength(0);
  enabled = true;
  await service().recover();
  expect((await events())[0]).toMatchObject({ complete: true, agentOutputTokens: 7 });
});

it("does no transcript reads or new tracking while opted out", async () => {
  enabled = false;
  const readUsage = vi.fn();
  const recovery = new AgentUsageRecovery({ storagePath: dir, homeDir: home, log: log(), clock, readUsage });
  expect(await recovery.track(links, folder)).toBe(false);
  await recovery.recover();
  expect(readUsage).not.toHaveBeenCalled(); expect(await events()).toHaveLength(0);
});

it("does not lose a job when opt-out races an in-flight read", async () => {
  await service().track(links, folder); await usage();
  const recovery = new AgentUsageRecovery({ storagePath: dir, homeDir: home, log: log(), clock,
    readUsage: async () => { enabled = false; return { agentInputTokens: 20, agentOutputTokens: 7, agentCacheReadTokens: 100, agentCacheCreationTokens: 40, agentCostUsd: null, usageAvailable: true }; } });
  await recovery.closeSession("session-1"); expect(await events()).toHaveLength(0);
  enabled = true; await service().recover();
  expect((await events())[0]).toMatchObject({ complete: true });
});

it("deduplicates a completed usage event after a crash before its job checkpoint", async () => {
  const repository = new JsonlRepository<UsageJob>(path.join(dir, "agent-usage-pending.jsonl"));
  const jobs: Repository<UsageJob> = {
    list: () => repository.list(), byDraft: id => repository.byDraft(id), bySession: id => repository.bySession(id),
    append: async row => { if (row.state === "complete") throw new Error("checkpoint interrupted"); return repository.append(row); },
  };
  const recovery = service(log(), jobs);
  await recovery.track(links, folder); await usage();
  await expect(recovery.closeSession("session-1")).rejects.toThrow("checkpoint interrupted");
  expect(await events()).toHaveLength(1);
  await service().recover(); await service().recover();
  expect(await events()).toHaveLength(1);
  expect((await events())[0].complete).toBe(true);
});

it("retries failed log writes without marking usage complete", async () => {
  await service().track(links, folder); await usage();
  const failed = log(); failed.writeOnce = async () => { throw new Error("disk unavailable"); };
  await expect(service(failed).closeSession("session-1")).rejects.toThrow("disk unavailable");
  await service().recover();
  expect((await events())[0]).toMatchObject({ complete: true, agentInputTokens: 20 });
});

it("never attributes another workspace/session, and rejects path traversal", async () => {
  await expect(service().track({ ...links, sessionId: "../../outside" }, folder)).rejects.toThrow("Invalid agent session id");
  await service().track({ ...links, sessionId: "another-session" }, folder);
  await usage(); await service().recover();
  expect((await events())[0]).toMatchObject({ sessionId: "another-session", usageAvailable: false, reason: "session-not-found" });
});

it("cancels a failed handoff so restarts do not collect it", async () => {
  const recovery = service(); await recovery.track(links, folder); await recovery.cancel(links.sendId);
  await usage(); await service().recover();
  expect(await events()).toHaveLength(0);
});

it("imports previous opt-in terminal sends, but skips clipboard, unlogged and completed sends", async () => {
  const sends = new JsonlRepository<SendRecord>(path.join(dir, "sends.jsonl"));
  const study = new JsonlRepository<StudyData>(path.join(dir, "study-events-v2.jsonl"));
  const recorder = new StudyRecorder(study, clock, () => `legacy-${++ids}`);
  for (const id of ["send-1", "clipboard", "unlogged", "completed"]) {
    await sends.append({ id, ts: "t", draftId: id, folderUri: folder, sessionId: "session-1", promptHash: "hash", text: "Do not duplicate this draft", target: id === "clipboard" ? "clipboard" : "terminal" });
    if (id !== "unlogged") await recorder.write("send", { draftId: id, sendId: id, sessionId: "session-1" }, { target: id === "clipboard" ? "clipboard" : "terminal" }, "legacy-participant");
  }
  await recorder.write("agent-usage", { draftId: "completed", sendId: "completed", sessionId: "session-1" }, { complete: true, usageAvailable: true });
  await usage(); await service().recover();
  const recovered = (await events()).filter(e => e.event === "agent-usage" && e.recovered);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ sendId: "send-1", participant: "legacy-participant", complete: false });
});

it("restored-terminal association uses exact launch metadata, never shell-string guessing", () => {
  expect(terminalSessionId({ env: { PREFLIGHT_AGENT_SESSION_ID: "session-1" } })).toBe("session-1");
  expect(terminalSessionId({ shellArgs: ["--session-id", "session-1", "--", "prompt"] })).toBe("session-1");
  expect(terminalSessionId({ shellArgs: "claude --session-id session-1" })).toBeUndefined();
  expect(terminalSessionId({ env: { PREFLIGHT_AGENT_SESSION_ID: "../../bad" } })).toBeUndefined();
  expect(terminalSessionId({})).toBeUndefined();
});

it("retries an older completed observation that never contained usable counters", async () => {
  const sends = new JsonlRepository<SendRecord>(path.join(dir, "sends.jsonl"));
  await sends.append({ id: links.sendId, ts: "t", draftId: links.draftId, folderUri: folder, sessionId: links.sessionId, promptHash: "hash", text: "draft", target: "terminal" });
  const recorder = new StudyRecorder(new JsonlRepository<StudyData>(path.join(dir, "study-events-v2.jsonl")), clock, () => `old-${++ids}`);
  await recorder.write("send", links, { target: "terminal" }, "original-participant");
  await recorder.write("agent-usage", links, { complete: true, usageAvailable: false });
  await usage(); await service().recover();
  expect((await events()).at(-1)).toMatchObject({ recovered: true, usageAvailable: true, agentOutputTokens: 7, complete: false });
});
