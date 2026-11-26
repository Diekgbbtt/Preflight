import {
  SpanKind,
  SpanStatusCode,
  context,
  trace as otelTrace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { Resource } from "@opentelemetry/resources";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { LlmErrorMeta, LlmTrace, ModelProfile, ModelRequest, ModelResponse } from "@prompt-preflight/core";
import { hashPrompt } from "@prompt-preflight/core";
import { OutputChannelLogProcessor, OutputChannelSpanProcessor, type LogChannel } from "./channel";
import { JsonlLogExporter, JsonlSpanExporter } from "./exporters";
import {
  NOOP_DEBUG_TRACE,
  NOOP_LLM_TRACE,
  NOOP_REVIEW_TRACE,
  type DebugLevel,
  type DebugTrace,
  type LlmTraceMeta,
  type ReviewTrace,
  type ReviewTraceMeta,
} from "./types";
import { JsonlTraceWriter } from "./writer";

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Debug tracing must never fail the review path.
  }
}

const SEVERITY: Record<DebugLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
};

function attributeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return value as string[];
    if (value.every((item) => typeof item === "number")) return value as number[];
    if (value.every((item) => typeof item === "boolean")) return value as boolean[];
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function attributes(values: Record<string, unknown> | undefined): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const converted = attributeValue(value);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export interface OtelDebugTraceOptions {
  dir: string;
  channel: LogChannel;
  resourceAttributes: Record<string, unknown>;
  sessionAttributes: Record<string, unknown>;
  version: string;
}

/** OTel-backed debug trace. One trace per activation or settings rebuild. */
export class OtelDebugTrace implements DebugTrace {
  readonly tracer: Tracer;
  private readonly logger: Logger;
  private readonly tracerProvider: BasicTracerProvider;
  private readonly loggerProvider: LoggerProvider;
  private readonly writer: JsonlTraceWriter;
  private readonly sessionSpan: Span;
  readonly sessionContext: Context;
  private readonly startedAt = performance.now();
  private disposed = false;

  private constructor(options: OtelDebugTraceOptions, writer: JsonlTraceWriter) {
    this.writer = writer;
    const resource = Resource.default().merge(new Resource(attributes(options.resourceAttributes)));
    this.tracerProvider = new BasicTracerProvider({ resource });
    this.tracerProvider.addSpanProcessor(
      new SimpleSpanProcessor(new JsonlSpanExporter(writer)),
    );
    this.tracerProvider.addSpanProcessor(new OutputChannelSpanProcessor(options.channel));
    this.loggerProvider = new LoggerProvider({ resource });
    this.loggerProvider.addLogRecordProcessor(
      new SimpleLogRecordProcessor(new JsonlLogExporter(writer)),
    );
    this.loggerProvider.addLogRecordProcessor(new OutputChannelLogProcessor(options.channel));
    this.tracer = this.tracerProvider.getTracer("prompt-preflight", options.version);
    this.logger = this.loggerProvider.getLogger("prompt-preflight", options.version);
    this.sessionSpan = this.tracer.startSpan("session", {
      kind: SpanKind.INTERNAL,
      attributes: attributes({ ...options.resourceAttributes, ...options.sessionAttributes }),
    });
    this.sessionContext = otelTrace.setSpan(context.active(), this.sessionSpan);
    this.sessionSpan.addEvent("session.start");
    this.log("session.start", { ...options.resourceAttributes, ...options.sessionAttributes }, "info");
  }

  static create(options: OtelDebugTraceOptions): OtelDebugTrace {
    let instance: OtelDebugTrace | undefined;
    const writer = new JsonlTraceWriter({
      dir: options.dir,
      onRotate: (file) => setImmediate(() => instance?.storage("rotate", { file })),
    });
    instance = new OtelDebugTrace(options, writer);
    return instance;
  }

  /** The current JSONL file. */
  get filePath(): string {
    return this.writer.filePath;
  }

  startReview(meta: ReviewTraceMeta): ReviewTrace {
    if (this.disposed) return NOOP_REVIEW_TRACE;
    try {
      const promptHash = hashPrompt(meta.prompt);
      const span = this.tracer.startSpan(
        `review.${meta.mode}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: attributes({
            "prompt_preflight.mode": meta.mode,
            "prompt_preflight.provider": meta.profile.provider,
            "gen_ai.request.model": meta.profile.model,
            "prompt_preflight.thinking_effort": meta.profile.thinkingEffort,
            "prompt_preflight.prompt_hash": promptHash,
            "prompt_preflight.prompt_chars": meta.prompt.length,
            "prompt_preflight.attempt": meta.attempt,
          }),
        },
        this.sessionContext,
      );
      return new ReviewTraceImpl(this, meta, promptHash, span);
    } catch {
      return NOOP_REVIEW_TRACE;
    }
  }

  event(name: string, values: Record<string, unknown> = {}, level: DebugLevel = "info"): void {
    this.log(name, values, level, this.sessionContext);
  }

  storage(action: string, values: Record<string, unknown> = {}): void {
    this.log("storage.debug", { "prompt_preflight.storage_action": action, ...values }, "info", this.sessionContext);
  }

  log(name: string, values: Record<string, unknown> | undefined, level: DebugLevel, ctx: Context = this.sessionContext): void {
    if (this.disposed) return;
    safe(() =>
      this.logger.emit({
        context: ctx,
        severityNumber: SEVERITY[level].number,
        severityText: SEVERITY[level].text,
        body: name,
        attributes: {
          "event.name": name,
          "event.domain": "prompt-preflight",
          ...attributes(values),
        },
      }),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.sessionSpan.addEvent("session.end");
    this.log("session.end", { "prompt_preflight.uptime_ms": performance.now() - this.startedAt }, "info");
    this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
    this.sessionSpan.end();
    this.disposed = true;
    let failure: unknown;
    try {
      await this.tracerProvider.shutdown();
      await this.loggerProvider.shutdown();
    } catch (error) {
      failure = error;
    } finally {
      try {
        await this.writer.close();
      } catch (error) {
        failure = failure ?? error;
      }
    }
    if (failure) throw failure;
  }
}

class ReviewTraceImpl implements ReviewTrace {
  readonly trace: OtelDebugTrace;
  readonly meta: ReviewTraceMeta;
  readonly promptHash: string;
  readonly span: Span;
  readonly ctx: Context;
  private ended = false;
  private failed = false;

  constructor(trace: OtelDebugTrace, meta: ReviewTraceMeta, promptHash: string, span: Span) {
    this.trace = trace;
    this.meta = meta;
    this.promptHash = promptHash;
    this.span = span;
    this.ctx = otelTrace.setSpan(trace.sessionContext, span);
    this.event(
      "review.start",
      {
        "prompt_preflight.mode": meta.mode,
        "prompt_preflight.provider": meta.profile.provider,
        "gen_ai.request.model": meta.profile.model,
        "prompt_preflight.thinking_effort": meta.profile.thinkingEffort,
        "prompt_preflight.prompt_hash": promptHash,
        "prompt_preflight.prompt_chars": meta.prompt.length,
        "prompt_preflight.attempt": meta.attempt,
      },
      "info",
    );
  }

  event(name: string, values: Record<string, unknown> = {}, level: DebugLevel = "info"): void {
    safe(() => this.span.addEvent(name, attributes(values)));
    this.emit(name, values, level, this.ctx);
  }

  emit(name: string, values: Record<string, unknown> | undefined, level: DebugLevel, ctx: Context): void {
    this.trace.log(name, { ...values, "prompt_preflight.mode": this.meta.mode }, level, ctx);
  }

  health(
    cliPath: string,
    result: { ok: boolean; error?: { code: string; message: string } },
    rttMs: number,
  ): void {
    safe(() => {
      const start = new Date(Date.now() - Math.max(0, rttMs));
      const span = this.trace.tracer.startSpan(
        "health.check",
        {
          kind: SpanKind.INTERNAL,
          startTime: start,
          attributes: attributes({
            "process.command": cliPath,
            "prompt_preflight.health.ok": result.ok,
            "prompt_preflight.error_code": result.error?.code,
            "prompt_preflight.rtt_ms": rttMs,
          }),
        },
        this.ctx,
      );
      span.setStatus(
        result.ok
          ? { code: SpanStatusCode.OK }
          : { code: SpanStatusCode.ERROR, message: result.error?.message ?? "health check failed" },
      );
      span.end();
    });
    this.event(
      "review.health",
      {
        "process.command": cliPath,
        "prompt_preflight.health.ok": result.ok,
        "prompt_preflight.error_code": result.error?.code,
        "prompt_preflight.rtt_ms": rttMs,
        "error.message": result.error?.message,
      },
      result.ok ? "info" : "warn",
    );
  }

  llm(meta: LlmTraceMeta): LlmTrace {
    return new LlmTraceImpl(this, meta);
  }

  parsed(review: unknown): void {
    const value = review as {
      verdict?: unknown;
      issues?: unknown[];
      questions?: unknown[];
      score?: { score?: unknown };
    };
    this.event(
      "review.parsed",
      {
        "review.verdict": value?.verdict,
        "review.issues": Array.isArray(value?.issues) ? value.issues.length : undefined,
        "review.questions": Array.isArray(value?.questions) ? value.questions.length : undefined,
        "review.score": value?.score?.score,
        "review.json": JSON.stringify(review),
      },
      "info",
    );
  }

  error(error: unknown, mapped?: { code: string; action: string; retryable: boolean }): void {
    const message = errorMessage(error);
    this.failed = true;
    safe(() => this.span.setStatus({ code: SpanStatusCode.ERROR, message }));
    this.event(
      "review.error",
      {
        "error.message": message,
        "error.stack": errorStack(error),
        "prompt_preflight.error_code": mapped?.code,
        "prompt_preflight.error_action": mapped?.action,
        "prompt_preflight.retryable": mapped?.retryable,
      },
      "error",
    );
  }

  end(status: "ok" | "error" = "ok"): void {
    if (this.ended) return;
    this.ended = true;
    safe(() => {
      this.span.addEvent("review.end", attributes({ "prompt_preflight.review_status": status }));
      if (status === "error" || this.failed) this.span.setStatus({ code: SpanStatusCode.ERROR });
      else this.span.setStatus({ code: SpanStatusCode.OK });
      this.span.end();
    });
  }
}

class LlmTraceImpl implements LlmTrace {
  private readonly review: ReviewTraceImpl;
  private readonly meta: LlmTraceMeta;
  private span: Span | undefined;
  private ctx: Context | undefined;
  private profile: ModelProfile | undefined;
  private requested = false;
  private ended = false;

  constructor(review: ReviewTraceImpl, meta: LlmTraceMeta) {
    this.review = review;
    this.meta = meta;
  }

  request(request: ModelRequest, profile: ModelProfile): void {
    if (this.requested || this.ended) return;
    this.requested = true;
    this.profile = profile;
    const attrs = {
      "gen_ai.system": "anthropic",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": profile.model,
      "prompt_preflight.provider": profile.provider,
      "prompt_preflight.mode": this.meta.mode,
      "prompt_preflight.generation_method": this.meta.generationMethod,
      "prompt_preflight.thinking_effort": profile.thinkingEffort,
      "prompt_preflight.timeout_ms": this.meta.timeoutMs,
      "prompt_preflight.prompt_hash": this.review.promptHash,
      "prompt_preflight.prompt_chars": request.user.length,
    };
    safe(() => {
      this.span = this.review.trace.tracer.startSpan(
        "llm.call",
        { kind: SpanKind.CLIENT, attributes: attributes(attrs) },
        this.review.ctx,
      );
      this.ctx = otelTrace.setSpan(this.review.ctx, this.span);
      this.span.addEvent("request");
    });
    this.review.emit(
      "llm.request",
      {
        ...attrs,
        "llm.request.system": request.system,
        "llm.request.user": request.user,
        "llm.request.system_chars": request.system.length,
        "llm.request.user_chars": request.user.length,
      },
      "info",
      this.ctx ?? this.review.ctx,
    );
  }

  process(args: readonly string[], cwd: string | undefined, pid: number | undefined): void {
    if (this.ended) return;
    safe(() =>
      this.span?.addEvent(
        "process",
        attributes({ "process.pid": pid, "process.cwd": cwd, "llm.process.argc": args.length }),
      ),
    );
    this.review.emit(
      "llm.process",
      {
        "process.args": args,
        "process.cwd": cwd,
        "process.pid": pid,
        "llm.process.argc": args.length,
      },
      "debug",
      this.ctx ?? this.review.ctx,
    );
  }

  stdin(text: string): void {
    if (this.ended) return;
    safe(() => this.span?.addEvent("stdin", attributes({ "llm.stdin.chars": text.length })));
    this.review.emit(
      "llm.stdin",
      { "llm.stdin.chars": text.length, "llm.stdin.hash": hashPrompt(text) },
      "debug",
      this.ctx ?? this.review.ctx,
    );
  }

  stdout(text: string): void {
    if (this.ended) return;
    safe(() => this.span?.addEvent("stdout", attributes({ "llm.stdout.chars": text.length })));
    this.review.emit(
      "llm.stdout",
      { "llm.stdout.chars": text.length, "llm.stdout": text },
      "debug",
      this.ctx ?? this.review.ctx,
    );
  }

  stderr(text: string): void {
    if (this.ended) return;
    safe(() => this.span?.addEvent("stderr", attributes({ "llm.stderr.chars": text.length })));
    this.review.emit(
      "llm.stderr",
      { "llm.stderr.chars": text.length, "llm.stderr": text },
      "warn",
      this.ctx ?? this.review.ctx,
    );
  }

  response(response: ModelResponse, rttMs: number): void {
    if (this.ended) return;
    this.ended = true;
    const attrs = {
      "gen_ai.usage.input_tokens": response.inputTokens,
      "gen_ai.usage.output_tokens": response.outputTokens,
      "gen_ai.response.model": this.profile?.model,
      "prompt_preflight.cost_usd": response.costUsd,
      "prompt_preflight.rtt_ms": rttMs,
      "llm.response.chars": response.text.length,
      "llm.response.text": response.text,
    };
    safe(() => {
      this.span?.setAttributes(attributes(attrs));
      this.span?.addEvent("response");
      this.span?.setStatus({ code: SpanStatusCode.OK });
    });
    this.review.emit("llm.response", attrs, "info", this.ctx ?? this.review.ctx);
    safe(() => this.span?.end());
  }

  error(error: unknown, rttMs: number, meta?: LlmErrorMeta): void {
    if (this.ended) return;
    this.ended = true;
    const attrs = {
      "error.type": error instanceof Error ? error.name : typeof error,
      "error.message": errorMessage(error),
      "error.stack": errorStack(error),
      "prompt_preflight.rtt_ms": rttMs,
      "prompt_preflight.exit_code": meta?.exitCode,
      "prompt_preflight.signal": meta?.signal,
      "prompt_preflight.killed": meta?.killed,
      "prompt_preflight.timed_out": meta?.timedOut,
      "prompt_preflight.aborted": meta?.aborted,
      "prompt_preflight.parse_error": meta?.parseError,
    };
    safe(() => {
      if (!this.span) return;
      this.span.setAttributes(attributes(attrs));
      this.span.recordException(error instanceof Error ? error : new Error(String(error)));
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
    });
    this.review.emit("llm.error", attrs, "error", this.ctx ?? this.review.ctx);
    safe(() => this.span?.end());
  }
}
