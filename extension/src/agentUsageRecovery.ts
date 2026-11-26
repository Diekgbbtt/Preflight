import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Clock, type Event, type Repository, type SendRecord } from "@prompt-preflight/core";
import { readAgentUsage, type AgentUsage } from "./agentUsage";
import { canonicalFolderUri, encodeClaudeProjectPath } from "./sessionLocator";
import { JsonlRepository } from "./repository";
import type { StudyData, StudyLinks } from "./studyEvents";

export interface UsageLog {
  readonly enabled: boolean;
  readonly participant: string;
  getEvents(): Promise<Event<StudyData>[]>;
  writeOnce(event: "agent-usage", links: StudyLinks, data: Record<string, unknown>, eventId: string, participant?: string): Promise<boolean>;
}
export interface UsageJob extends StudyLinks {
  sessionId: string;
  folderUri: string;
  participant: string;
  state: "pending" | "closed" | "complete" | "cancelled";
}
interface RecoveryOptions {
  storagePath: string;
  log: UsageLog;
  homeDir?: string;
  clock?: Clock;
  jobs?: Repository<UsageJob>;
  sends?: Repository<SendRecord>;
  readUsage?: (file: string) => Promise<AgentUsage>;
}

/** Durable lane-3 accounting. Never calls a provider or guesses a session from recency. */
export class AgentUsageRecovery {
  private readonly jobs: Repository<UsageJob>;
  private readonly sends: Repository<SendRecord>;
  private readonly clock: Clock;
  private readonly readUsage: (file: string) => Promise<AgentUsage>;
  private queue: Promise<unknown> = Promise.resolve();
  private recovery?: Promise<void>;
  private readonly observedFiles = new Map<string, string>();
  private legacyImported = false;

  constructor(private readonly options: RecoveryOptions) {
    this.jobs = options.jobs ?? new JsonlRepository(path.join(options.storagePath, "agent-usage-pending.jsonl"));
    this.sends = options.sends ?? new JsonlRepository(path.join(options.storagePath, "sends.jsonl"));
    this.clock = options.clock ?? { now: Date.now };
    this.readUsage = options.readUsage ?? readAgentUsage;
  }

  /** Persist intent before handing off; false means logging was disabled. */
  track(links: StudyLinks, folderUri: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.options.log.enabled || !links.sessionId) return false;
      this.transcriptPath(folderUri, links.sessionId); // Validate metadata before persisting it.
      const current = (await this.latest()).get(links.sendId);
      if (current && (current.state !== "cancelled" || current.sessionId === links.sessionId)) {
        return current.state !== "cancelled" && current.sessionId === links.sessionId;
      }
      await this.save({ ...links, sessionId: links.sessionId, folderUri: canonicalFolderUri(folderUri), participant: this.options.log.participant, state: "pending" });
      return true;
    });
  }

  cancel(sendId: string): Promise<void> {
    return this.enqueue(async () => {
      const job = (await this.latest()).get(sendId);
      if (job && job.state !== "complete" && job.state !== "cancelled") {
        await this.save({ ...job, state: "cancelled" });
        this.observedFiles.delete(sendId);
      }
    });
  }

  /** Can be called by a restored terminal, even after the original panel was destroyed. */
  closeSession(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const jobs = await this.latest();
      for (const job of jobs.values()) {
        if (job.sessionId !== sessionId || job.state === "complete" || job.state === "cancelled") continue;
        const closed: UsageJob = { ...job, state: "closed" };
        // Preserve exit evidence even when logging is currently off.
        if (job.state !== "closed") await this.save(closed);
        if (this.options.log.enabled) await this.collect(closed, false);
      }
    });
  }

  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = this.enqueue(async () => {
      if (!this.options.log.enabled) return;
      await this.importPreviousSends();
      for (const job of (await this.latest()).values()) {
        if (!this.options.log.enabled) return;
        if (job.state === "pending" || job.state === "closed") await this.collect(job, true);
      }
    }).finally(() => { this.recovery = undefined; });
    return this.recovery;
  }

  private async collect(job: UsageJob, recovered: boolean): Promise<void> {
    let data: Record<string, unknown>;
    let signature: string | undefined;
    try {
      const file = this.transcriptPath(job.folderUri, job.sessionId);
      const info = await stat(file);
      signature = `${job.sessionId}:${job.state}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.observedFiles.get(job.sendId) === signature || !this.options.log.enabled) return;
      const usage = await this.readUsage(file);
      data = { provider: "claude", ...usage, complete: job.state === "closed" && usage.usageAvailable };
    } catch (error) {
      signature = undefined;
      this.observedFiles.delete(job.sendId);
      data = { provider: "claude", usageAvailable: false, complete: false,
        reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "session-not-found" : "transcript-unreadable" };
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    // An interrupted checkpoint may replay this exact event; the log deduplicates its durable ID.
    const eventId = `agent-usage:${job.sendId}:${fingerprint}`;
    const written = await this.options.log.writeOnce("agent-usage", {
      draftId: job.draftId, sendId: job.sendId, sessionId: job.sessionId,
    }, { ...data, recovered, observation: "cumulative-snapshot" }, eventId, job.participant);
    if (written && data.complete === true) {
      await this.save({ ...job, state: "complete" });
      this.observedFiles.delete(job.sendId);
    } else if (written && signature) {
      this.observedFiles.set(job.sendId, signature);
    }
  }

  private transcriptPath(folderUri: string, sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid agent session id");
    const folder = fileURLToPath(canonicalFolderUri(folderUri));
    return path.join(this.options.homeDir ?? os.homedir(), ".claude", "projects", encodeClaudeProjectPath(folder), `${sessionId}.jsonl`);
  }

  private async latest(): Promise<Map<string, UsageJob>> {
    const latest = new Map<string, UsageJob>();
    for (const row of (await this.jobs.list()).events) {
      if (typeof row.draftId !== "string" || typeof row.participant !== "string" || typeof row.sendId !== "string" || typeof row.sessionId !== "string" || typeof row.folderUri !== "string" ||
        !["pending", "closed", "complete", "cancelled"].includes(row.state)) continue;
      latest.set(row.sendId, row);
    }
    return latest;
  }

  private save(job: UsageJob): Promise<unknown> {
    return this.jobs.append({ ...job, id: job.sendId, ts: new Date(this.clock.now()).toISOString() });
  }

  /** Upgrade existing opt-in sends. Unlogged and clipboard sends are never imported. */
  private async importPreviousSends(): Promise<void> {
    if (this.legacyImported) return;
    const events = await this.options.log.getEvents();
    const completed = new Set(events.filter(e => e.event === "agent-usage" && e.complete === true && e.usageAvailable === true).map(e => e.sendId));
    const logged = new Map(events.filter(e => e.event === "send" && e.target === "terminal").map(e => [e.sendId, e]));
    const jobs = await this.latest();
    const sends = new Map((await this.sends.list()).events.map(e => [e.id, e]));
    for (const send of sends.values()) {
      const observation = logged.get(send.id);
      if (!observation || !send.sessionId || send.sessionId !== observation.sessionId || send.target !== "terminal" || jobs.has(send.id) || completed.has(send.id)) continue;
      try { this.transcriptPath(send.folderUri, send.sessionId); } catch { continue; }
      await this.save({ draftId: send.draftId, sendId: send.id, sessionId: send.sessionId, folderUri: canonicalFolderUri(send.folderUri), participant: observation.participant, state: "pending" });
    }
    this.legacyImported = true;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Restored terminals retain launch metadata on supported VS Code hosts. */
export function terminalSessionId(options: { env?: Record<string, string | null | undefined>; shellArgs?: string[] | string }): string | undefined {
  const explicit = options.env?.PREFLIGHT_AGENT_SESSION_ID;
  if (explicit && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit;
  if (!Array.isArray(options.shellArgs)) return undefined;
  const index = options.shellArgs.indexOf("--session-id");
  const candidate = index >= 0 ? options.shellArgs[index + 1] : undefined;
  return candidate && /^[a-zA-Z0-9_-]+$/.test(candidate) ? candidate : undefined;
}
