import * as fs from "node:fs";
import * as path from "node:path";
import { createStream, type Generator, type RotatingFileStream } from "rotating-file-stream";
import {
  DEBUG_FILE_NAME,
  DEBUG_HISTORY_NAME,
  DEBUG_MAX_FILES,
  DEBUG_MAX_SIZE,
  isDebugTraceFile,
} from "./path";
import { traceReplacer, type JsonRecord } from "./serialize";

export interface WriterOptions {
  dir: string;
  maxSize?: string;
  maxFiles?: number;
  onRotate?: (file: string) => void;
}

/** Serialized JSONL writer over a size-rotated stream. */
export class JsonlTraceWriter {
  private readonly stream: RotatingFileStream;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastError: Error | undefined;
  readonly filePath: string;

  constructor(options: WriterOptions) {
    fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(options.dir, DEBUG_FILE_NAME);
    const generator: Generator = (time, index) => {
      if (time === null || index === undefined) return DEBUG_FILE_NAME;
      return `llm-trace.${index}.jsonl`;
    };
    this.stream = createStream(generator, {
      path: options.dir,
      size: options.maxSize ?? DEBUG_MAX_SIZE,
      maxFiles: options.maxFiles ?? DEBUG_MAX_FILES,
      history: DEBUG_HISTORY_NAME,
      mode: 0o600,
      encoding: "utf8",
    });
    this.stream.on("error", (error: Error) => {
      this.lastError = error;
    });
    this.stream.on("rotated", (file: string) => {
      options.onRotate?.(file);
    });
  }

  /** Appends one record. The write is serialized behind earlier records. */
  write(record: JsonRecord): Promise<void> {
    if (this.closed) return Promise.reject(new Error("debug trace writer is closed"));
    const line = JSON.stringify(record, traceReplacer) + "\n";
    const next = this.queue.then(() => this.writeLine(line));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Resolves after every queued record has been handed to the stream. */
  flush(): Promise<void> {
    return this.queue;
  }

  /** Flushes and closes the underlying stream. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await new Promise<void>((resolve) => this.stream.end(() => resolve()));
    if (this.lastError) throw this.lastError;
  }

  private writeLine(line: string): Promise<void> {
    if (this.lastError) return Promise.reject(this.lastError);
    return new Promise<void>((resolve, reject) => {
      this.stream.write(line, (error?: Error | null) => {
        if (error) {
          this.lastError = error;
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/** Lists the current file, rotated files, and the rotation history. */
export async function listTraceFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(dir);
    return names.filter(isDebugTraceFile).map((name) => path.join(dir, name));
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Deletes the current file, rotated files, and the rotation history. */
export async function clearTraceFiles(dir: string): Promise<number> {
  const files = await listTraceFiles(dir);
  await Promise.all(files.map((file) => fs.promises.rm(file, { force: true })));
  return files.length;
}
