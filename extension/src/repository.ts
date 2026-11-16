/**
 * Node JSONL repository implementation. Node APIs only: no `vscode` import.
 * Core envelope types and the migration runner come from `@prompt-preflight/core`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  SCHEMA_VERSION,
  isValidEvent,
  type ClearResult,
  type Event,
  type EventInput,
  type ListResult,
  type Repository,
} from "@prompt-preflight/core";

/**
 * Append-only JSONL repository for one file. One JSON object per line, UTF-8,
 * `\n` terminated. Appends use `fs.appendFile` behind a per-file promise queue.
 * Corrupt lines are skipped and counted on read; the file is never repaired.
 */
export class JsonlRepository<T> implements Repository<T> {
  private events: Event<T>[] = [];
  private skipped = 0;
  private maxSeq = 0;
  private byDraftIndex = new Map<string, Event<T>[]>();
  private bySessionIndex = new Map<string, Event<T>[]>();
  private queue: Promise<unknown> = Promise.resolve();
  private clearing = false;
  private loadPromise: Promise<void> | null = null;
  private partial: string | null = null;

  constructor(private readonly filePath: string) {}

  async append(event: EventInput<T>): Promise<Event<T>> {
    if (this.clearing) throw new Error("repository is clearing");
    return this.enqueue(() => this.appendRaw(event));
  }

  async list(): Promise<ListResult<T>> {
    return this.enqueue(async () => {
      await this.load();
      return { events: this.sortedEvents(this.events), skipped: this.skipped };
    });
  }

  async byDraft(draftId: string): Promise<Event<T>[]> {
    return this.enqueue(async () => {
      await this.load();
      return this.sortedEvents(this.byDraftIndex.get(draftId) ?? []);
    });
  }

  async bySession(sessionId: string): Promise<Event<T>[]> {
    return this.enqueue(async () => {
      await this.load();
      return this.sortedEvents(this.bySessionIndex.get(sessionId) ?? []);
    });
  }

  async clear(): Promise<ClearResult> {
    this.clearing = true;
    return this.enqueue(async () => {
      try {
        await this.load();
        const deleted = this.events.length;
        try {
          await fs.unlink(this.filePath);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
        this.events = [];
        this.skipped = 0;
        this.maxSeq = 0;
        this.byDraftIndex.clear();
        this.bySessionIndex.clear();
        this.partial = null;
        this.loadPromise = null;
        return { deleted };
      } finally {
        this.clearing = false;
      }
    });
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Copy of the given events sorted by `seq` ascending. JavaScript sort is
   * stable, so events with equal seq keep file order. A copy also stops
   * callers from mutating the in-memory indexes.
   */
  private sortedEvents(events: Event<T>[]): Event<T>[] {
    return [...events].sort((a, b) => a.seq - b.seq);
  }

  private async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFile().catch((error) => {
      // Retry the read on the next operation instead of caching the failure.
      this.loadPromise = null;
      throw error;
    });
    return this.loadPromise;
  }

  private async loadFile(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    if (content.length === 0) return;
    const hasTrailingNewline = content.endsWith("\n");
    const complete = hasTrailingNewline ? content.slice(0, -1) : content;
    const segments = complete.split("\n");
    const tail = segments.length - 1;
    for (let i = 0; i < tail; i++) {
      this.adoptLine(segments[i]);
    }
    if (hasTrailingNewline) {
      this.adoptLine(segments[segments.length - 1]);
      return;
    }
    // Trailing partial line without `\n`: an interrupted write. Remember it;
    // the next append terminates it before writing its own record.
    this.partial = segments[segments.length - 1];
  }

  private adoptLine(line: string): void {
    if (line.trim() === "") {
      this.skipped++;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.skipped++;
      return;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const seq = (parsed as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isFinite(seq) && seq > this.maxSeq) this.maxSeq = seq;
    }
    if (!isValidEvent(parsed)) {
      this.skipped++;
      return;
    }
    if (parsed.schemaVersion > SCHEMA_VERSION) {
      this.skipped++;
      return;
    }
    const event = parsed as Event<T>;
    this.events.push(event);
    this.indexEvent(event);
  }

  private indexEvent(event: Event<T>): void {
    const draftsFile = path.basename(this.filePath) === "drafts.jsonl";
    if (draftsFile) {
      const list = this.byDraftIndex.get(event.id) ?? [];
      list.push(event);
      this.byDraftIndex.set(event.id, list);
    } else {
      const draftId = (event as { draftId?: unknown }).draftId;
      if (typeof draftId === "string") {
        const list = this.byDraftIndex.get(draftId) ?? [];
        list.push(event);
        this.byDraftIndex.set(draftId, list);
      }
    }
    const sessionId = (event as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string") {
      const list = this.bySessionIndex.get(sessionId) ?? [];
      list.push(event);
      this.bySessionIndex.set(sessionId, list);
    }
  }

  private async appendRaw(event: EventInput<T>): Promise<Event<T>> {
    await this.load();
    let seq = this.maxSeq + 1;
    let terminatedPartial: string | null = null;
    let adopted: Event<T> | null = null;
    let extraSkipped = 0;
    let nextMaxSeq = this.maxSeq;
    if (this.partial !== null) {
      terminatedPartial = this.partial;
      let parsed: unknown;
      try {
        parsed = JSON.parse(terminatedPartial);
      } catch {
        parsed = undefined;
      }
      // Any parseable object with a finite numeric seq raises the max, even if
      // the rest of the envelope is invalid or from a future version.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const partialSeq = (parsed as { seq?: unknown }).seq;
        if (typeof partialSeq === "number" && Number.isFinite(partialSeq) && partialSeq > nextMaxSeq) {
          nextMaxSeq = partialSeq;
          seq = partialSeq + 1;
        }
      }
      // Adopt the partial only when it is a valid current-or-older event.
      if (parsed !== undefined && isValidEvent(parsed) && parsed.schemaVersion <= SCHEMA_VERSION) {
        adopted = parsed as Event<T>;
      } else {
        extraSkipped = 1;
      }
    }
    const stored = { ...event, seq, schemaVersion: SCHEMA_VERSION } as Event<T>;
    const body = JSON.stringify(stored) + "\n";
    // A trailing partial segment is terminated by a leading newline. The
    // partial text is never rewritten or truncated.
    const data = terminatedPartial === null ? body : "\n" + body;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, data, "utf8");
    // The write resolved: commit the in-memory state. Nothing above mutated
    // it, so a rejected write leaves the repository exactly as it was.
    this.partial = null;
    this.maxSeq = nextMaxSeq;
    this.skipped += extraSkipped;
    if (adopted) {
      this.events.push(adopted);
      this.indexEvent(adopted);
    }
    this.events.push(stored);
    this.indexEvent(stored);
    if (seq > this.maxSeq) this.maxSeq = seq;
    return stored;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
