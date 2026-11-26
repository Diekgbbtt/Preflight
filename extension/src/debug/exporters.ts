import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { serializeLog, serializeSpan } from "./serialize";
import type { JsonlTraceWriter } from "./writer";

function failure(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Writes spans into the shared JSONL trace writer. */
export class JsonlSpanExporter implements SpanExporter {
  constructor(private readonly writer: JsonlTraceWriter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    Promise.all(spans.map((span) => this.writer.write(serializeSpan(span))))
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((error) => resultCallback({ code: ExportResultCode.FAILED, error: failure(error) }));
  }

  async shutdown(): Promise<void> {
    await this.writer.flush();
  }

  async forceFlush(): Promise<void> {
    await this.writer.flush();
  }
}

/** Writes log records into the shared JSONL trace writer. */
export class JsonlLogExporter implements LogRecordExporter {
  constructor(private readonly writer: JsonlTraceWriter) {}

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    Promise.all(logs.map((record) => this.writer.write(serializeLog(record))))
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((error) => resultCallback({ code: ExportResultCode.FAILED, error: failure(error) }));
  }

  async shutdown(): Promise<void> {
    await this.writer.flush();
  }
}
