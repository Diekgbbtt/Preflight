/**
 * Generic append-only event envelope and migration runner.
 * Pure: no Node APIs. The repository implementation lives in the extension.
 *
 * The envelope is generic: the payload keys belong to the owners of the
 * aggregates. This module defines no aggregate schemas.
 */

/** Current envelope schema version, written on every append. */
export const SCHEMA_VERSION = 1;

/** Caller-supplied id and timestamp; the repository adds the envelope fields. */
export type EventInput<T> = { id: string; ts: string } & T;

/** Stored event. `seq` is monotonic per file and starts at 1. */
export type Event<T> = { schemaVersion: number; seq: number; id: string; ts: string } & T;

/** Result of a repository read. */
export interface ListResult<T> {
  events: Event<T>[];
  skipped: number;
}

/** Generic durable repository for one JSONL file. */
export interface Repository<T> {
  append(event: EventInput<T>): Promise<Event<T>>;
  list(): Promise<ListResult<T>>;
  byDraft(draftId: string): Promise<Event<T>[]>;
  bySession(sessionId: string): Promise<Event<T>[]>;
}

/** The only named payload type this ticket defines. The caller supplies `promptHash`. */
export interface SendRecord {
  draftId: string;
  folderUri: string;
  text: string;
  promptHash: string;
  sessionId?: string;
  target: "terminal" | "clipboard";
}

/** Generates aggregate and event ids. The composition root supplies `crypto.randomUUID`. */
export type IdGenerator = () => string;

/** Monotonic time source. The composition root supplies `Date.now`. */
export interface Clock {
  now(): number;
}

/**
 * One migration step for events of a given older schema version.
 * Returns the next-version event, or `null` to drop the event.
 */
export type MigrationStep = (event: Event<unknown>) => Event<unknown> | null;

/** Result of a pure migration pass. */
export interface MigrationResult<T> {
  events: Event<T>[];
  skipped: number;
}

/** Count of valid events a clear deleted. Corrupt lines are not counted. */
export interface ClearResult {
  deleted: number;
}

function isPlainEvent(value: unknown): value is Event<unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/** Envelope validation shared by reads and the migration runner. */
export function isValidEvent(value: unknown): value is Event<unknown> {
  if (!isPlainEvent(value)) return false;
  if (!isFiniteInteger(value.schemaVersion) || value.schemaVersion < 0) return false;
  if (!isFiniteInteger(value.seq) || value.seq < 1) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.ts !== "string") return false;
  return true;
}

/**
 * Pure, idempotent migration. Events already at `SCHEMA_VERSION` pass through.
 * Future versions, unknown steps, non-increasing steps, and `null` results are
 * skipped and counted, never migrated down. Inputs are not mutated. Files are
 * never rewritten here.
 */
export function migrate<T>(events: Event<T>[], steps: Record<number, MigrationStep> = {}): MigrationResult<T> {
  const out: Event<T>[] = [];
  let skipped = 0;
  for (const event of events) {
    if (!isValidEvent(event)) {
      skipped++;
      continue;
    }
    let current = event as Event<unknown>;
    while (current.schemaVersion < SCHEMA_VERSION) {
      const step = steps[current.schemaVersion];
      if (!step) break;
      const next = step(current);
      if (!next || !isValidEvent(next) || next.schemaVersion <= current.schemaVersion) break;
      current = next;
    }
    if (current.schemaVersion === SCHEMA_VERSION) {
      out.push(current as Event<T>);
    } else {
      skipped++;
    }
  }
  return { events: out, skipped };
}
