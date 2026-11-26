import { SpanKind, SpanStatusCode, type HrTime } from "@opentelemetry/api";
import { hrTimeToMilliseconds, hrTimeToNanoseconds } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";

export const TRACE_SCHEMA_VERSION = 1;

export type JsonRecord = Record<string, unknown>;

function iso(hrTime: HrTime): string {
  return new Date(hrTimeToMilliseconds(hrTime)).toISOString();
}

function nanos(hrTime: HrTime): string {
  return hrTimeToNanoseconds(hrTime).toString();
}

function spanKind(kind: SpanKind): string {
  return SpanKind[kind] ?? "INTERNAL";
}

function statusCode(code: SpanStatusCode): string {
  return code === SpanStatusCode.ERROR ? "ERROR" : code === SpanStatusCode.OK ? "OK" : "UNSET";
}

function scope(name: string | undefined, version: string | undefined): JsonRecord {
  return { name: name ?? "unknown", ...(version ? { version } : {}) };
}

/** Converts one readable span into the JSONL span record. */
export function serializeSpan(span: ReadableSpan): JsonRecord {
  const context = span.spanContext();
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "span",
    ts: iso(span.startTime),
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanId ?? null,
    traceFlags: context.traceFlags,
    isRemote: context.isRemote,
    name: span.name,
    kind: spanKind(span.kind),
    startTimeUnixNano: nanos(span.startTime),
    endTimeUnixNano: nanos(span.endTime),
    durationMs: hrTimeToMilliseconds(span.duration),
    status: {
      code: statusCode(span.status.code),
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    attributes: span.attributes,
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: nanos(event.time),
      attributes: event.attributes ?? {},
      ...(event.droppedAttributesCount ? { droppedAttributesCount: event.droppedAttributesCount } : {}),
    })),
    links: span.links.map((link) => ({
      traceId: link.context.traceId,
      spanId: link.context.spanId,
      traceFlags: link.context.traceFlags,
      isRemote: link.context.isRemote,
      attributes: link.attributes ?? {},
    })),
    resource: span.resource.attributes,
    instrumentationScope: scope(span.instrumentationLibrary.name, span.instrumentationLibrary.version),
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Converts one readable log record into the JSONL log record. */
export function serializeLog(record: ReadableLogRecord): JsonRecord {
  const context = record.spanContext;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "log",
    ts: iso(record.hrTime),
    timeUnixNano: nanos(record.hrTime),
    observedTimeUnixNano: nanos(record.hrTimeObserved),
    traceId: context?.traceId ?? null,
    spanId: context?.spanId ?? null,
    traceFlags: context?.traceFlags ?? null,
    isRemote: context?.isRemote ?? null,
    severityNumber: record.severityNumber ?? 0,
    severityText: record.severityText ?? "UNSPECIFIED",
    body: record.body ?? null,
    attributes: record.attributes,
    resource: record.resource.attributes,
    instrumentationScope: scope(record.instrumentationScope.name, record.instrumentationScope.version),
    droppedAttributesCount: record.droppedAttributesCount,
  };
}

/** JSON replacer for BigInt values that can appear in provider metadata. */
export function traceReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
