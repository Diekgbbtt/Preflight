import type { Context, HrTime } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { LogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";

/** The slice of vscode.LogOutputChannel used by the channel bridge. */
export interface LogChannel {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const PREVIEW_CHARS = 2000;

function clock(hrTime: HrTime): string {
  return new Date(hrTimeToMilliseconds(hrTime)).toISOString().slice(11, 23);
}

function levelFor(severity: SeverityNumber | undefined): keyof LogChannel {
  if (severity === undefined) return "debug";
  if (severity >= SeverityNumber.ERROR) return "error";
  if (severity >= SeverityNumber.WARN) return "warn";
  if (severity >= SeverityNumber.INFO) return "info";
  return "debug";
}

function preview(value: unknown, max = PREVIEW_CHARS): string {
  if (typeof value === "string") {
    const clipped = value.length > max ? value.slice(0, max) + "..." : value;
    return JSON.stringify(clipped);
  }
  if (value === undefined || value === null) return "";
  try {
    const text = JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + "..." : text;
  } catch {
    return String(value);
  }
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function attribute(attrs: Record<string, unknown>, key: string): unknown {
  return attrs[key];
}

function labelFor(event: string): string {
  switch (event) {
    case "llm.request":
      return "[LLM REQ]";
    case "llm.process":
      return "[LLM PROC]";
    case "llm.stdin":
      return "[LLM STDIN]";
    case "llm.stdout":
      return "[LLM STDOUT]";
    case "llm.stderr":
      return "[LLM STDERR]";
    case "llm.response":
      return "[LLM RES]";
    case "llm.error":
      return "[LLM ERR]";
    case "review.parsed":
      return "[REVIEW]";
    case "review.error":
      return "[REVIEW ERR]";
    case "review.health":
      return "[HEALTH]";
    case "ui.input":
      return "[UI INPUT]";
    case "ui.action":
      return "[UI]";
    case "ui.send":
      return "[SEND]";
    case "storage.studyLog":
      return "[STUDY]";
    case "storage.debug":
      return "[STORE]";
    case "session.start":
      return "[SESSION]";
    case "session.end":
      return "[SESSION]";
    case "config.change":
      return "[CONFIG]";
    default:
      return `[${event}]`;
  }
}

function details(event: string, attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (name: string, key: string): void => {
    const value = attribute(attrs, key);
    const text = preview(value);
    if (text !== "") parts.push(`${name}=${text}`);
  };
  const addScalar = (name: string, key: string): void => {
    const value = scalar(attribute(attrs, key));
    if (value !== undefined) parts.push(`${name}=${value}`);
  };

  switch (event) {
    case "llm.request":
      addScalar("provider", "prompt_preflight.provider");
      addScalar("model", "gen_ai.request.model");
      addScalar("effort", "prompt_preflight.thinking_effort");
      addScalar("method", "prompt_preflight.generation_method");
      addScalar("timeout", "prompt_preflight.timeout_ms");
      addScalar("hash", "prompt_preflight.prompt_hash");
      addScalar("chars", "prompt_preflight.prompt_chars");
      add("system", "llm.request.system");
      add("user", "llm.request.user");
      break;
    case "llm.process":
      addScalar("pid", "process.pid");
      add("cwd", "process.cwd");
      add("args", "llm.process.args");
      break;
    case "llm.stdin":
      addScalar("chars", "llm.stdin.chars");
      addScalar("hash", "llm.stdin.hash");
      break;
    case "llm.stdout":
    case "llm.stderr":
      addScalar("chars", event === "llm.stdout" ? "llm.stdout.chars" : "llm.stderr.chars");
      add("body", event === "llm.stdout" ? "llm.stdout" : "llm.stderr");
      break;
    case "llm.response":
      addScalar("rtt", "prompt_preflight.rtt_ms");
      addScalar("in", "gen_ai.usage.input_tokens");
      addScalar("out", "gen_ai.usage.output_tokens");
      addScalar("cost", "prompt_preflight.cost_usd");
      addScalar("chars", "llm.response.chars");
      add("text", "llm.response.text");
      break;
    case "llm.error":
      addScalar("code", "prompt_preflight.error_code");
      addScalar("exit", "prompt_preflight.exit_code");
      addScalar("signal", "prompt_preflight.signal");
      addScalar("killed", "prompt_preflight.killed");
      addScalar("timeout", "prompt_preflight.timed_out");
      addScalar("aborted", "prompt_preflight.aborted");
      addScalar("parse", "prompt_preflight.parse_error");
      add("message", "error.message");
      add("stack", "error.stack");
      break;
    case "review.health":
      addScalar("ok", "prompt_preflight.health.ok");
      addScalar("code", "prompt_preflight.error_code");
      addScalar("rtt", "prompt_preflight.rtt_ms");
      add("path", "process.command");
      break;
    case "review.parsed":
      addScalar("verdict", "review.verdict");
      addScalar("issues", "review.issues");
      addScalar("questions", "review.questions");
      add("json", "review.json");
      break;
    case "review.error":
      addScalar("code", "prompt_preflight.error_code");
      addScalar("action", "prompt_preflight.error_action");
      addScalar("retryable", "prompt_preflight.retryable");
      add("message", "error.message");
      break;
    case "ui.input":
      addScalar("chars", "prompt_preflight.prompt_chars");
      addScalar("words", "prompt_preflight.words");
      addScalar("score", "prompt_preflight.score");
      addScalar("level", "prompt_preflight.level");
      addScalar("findings", "prompt_preflight.findings");
      addScalar("questions", "prompt_preflight.questions");
      addScalar("hash", "prompt_preflight.prompt_hash");
      break;
    case "ui.send":
      addScalar("target", "prompt_preflight.send_target");
      addScalar("hash", "prompt_preflight.prompt_hash");
      addScalar("score", "prompt_preflight.score");
      addScalar("level", "prompt_preflight.level");
      addScalar("study", "prompt_preflight.study_log_enabled");
      add("text", "ui.send.text");
      break;
    default:
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "event.name" || key === "event.domain") continue;
        const text = preview(value);
        if (text !== "") parts.push(`${key}=${text}`);
      }
      break;
  }
  return parts.join(" ");
}

/** Formats one log record for the colored VS Code output channel. */
export function formatLogRecord(record: ReadableLogRecord): string {
  const attrs = (record.attributes ?? {}) as Record<string, unknown>;
  const event = String(attrs["event.name"] ?? record.body ?? "log");
  const trace = record.spanContext?.traceId.slice(0, 8) ?? "--------";
  const body = details(event, attrs);
  return `${clock(record.hrTime)} [${trace}] ${labelFor(event)}${body ? ` ${body}` : ""}`;
}

/** Writes log records to a VS Code LogOutputChannel. */
export class OutputChannelLogProcessor implements LogRecordProcessor {
  constructor(private readonly channel: LogChannel) {}

  onEmit(record: LogRecord, _context?: Context): void {
    try {
      this.channel[levelFor(record.severityNumber)](formatLogRecord(record));
    } catch {
      // The debug channel must never fail the review path.
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/** Writes span completion lines to a VS Code LogOutputChannel. */
export class OutputChannelSpanProcessor implements SpanProcessor {
  constructor(private readonly channel: LogChannel) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const trace = span.spanContext().traceId.slice(0, 8);
    const status =
      span.status.code === SpanStatusCode.ERROR ? "ERROR" : span.status.code === SpanStatusCode.OK ? "OK" : "UNSET";
    const line = `${clock(span.startTime)} [${trace}] [SPAN] ${span.name} ${Math.round(
      hrTimeToMilliseconds(span.duration),
    )}ms ${status}`;
    try {
      if (status === "ERROR") this.channel.warn(line);
      else this.channel.debug(line);
    } catch {
      // The debug channel must never fail the review path.
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
