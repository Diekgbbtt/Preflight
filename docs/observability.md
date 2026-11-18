# Debug observability

## Purpose

The debug trace is a separate local evaluation stream for the technical interaction between Prompt Preflight and the model provider.
It is not the study log.
The study log records user-study outcomes.
The debug trace records request packets, response packets, process mechanics, timings, and failure causes.

Debug tracing is off by default.
It is enabled by `promptPreflight.debug`.

## Settings

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `promptPreflight.debug` | boolean | `false` | Enable the debug trace, the colored output channel, and the JSONL file. |
| `promptPreflight.debugLogDir` | string | `""` | Directory for trace files. Empty resolves to `<context.globalStorageUri>/debug`. A relative path resolves under the global storage. An absolute path is used as is. |

The output file is always `llm-trace.jsonl` inside the resolved directory.
Rotation uses 10 MB per file and keeps 5 files.
Rotated files are `llm-trace.1.jsonl` through `llm-trace.5.jsonl`.
The directory is created with mode `0700`; files are created with mode `0600`.

The first enable shows a modal warning because the trace stores full prompts and responses.
The warning is stored under `promptPreflight.debugNotice.v1`.
Declining the warning turns `promptPreflight.debug` back off.

## Separation from the study log

The study log remains `study-log.jsonl` under `context.globalStorageUri`.
It is opt-in through `promptPreflight.studyLog.enabled`.
It records study outcomes and remains independent.
`promptPreflight.clearHistory` does not delete the debug trace.
The debug trace has its own clear command.

## OpenTelemetry mapping

Use the OpenTelemetry API and SDK primitives directly:

- `@opentelemetry/api` for `trace`, `context`, `SpanKind`, `SpanStatusCode`, and `Attributes`.
- `@opentelemetry/api-logs` for `logs`, `SeverityNumber`, and log records.
- `@opentelemetry/sdk-trace-base` for `BasicTracerProvider`, `SimpleSpanProcessor`, `SpanProcessor`, and `SpanExporter`.
- `@opentelemetry/sdk-logs` for `LoggerProvider`, `SimpleLogRecordProcessor`, `LogRecordProcessor`, and `LogRecordExporter`.
- `@opentelemetry/resources` for the shared `Resource`.
- `@opentelemetry/core` for `ExportResultCode` and high-resolution time conversion.
- `@opentelemetry/semantic-conventions` for standard attributes.

There is no global context manager.
The session span context is held explicitly and passed to child spans and log records.
This avoids changing process-wide OpenTelemetry state in the VS Code extension host.

### Resource attributes

- `service.name`: `prompt-preflight`
- `service.version`: extension version
- `service.instance.id`: random UUID per activation
- `vscode.version`
- `vscode.extension.id`: `prompt-preflight.prompt-preflight`
- `process.pid`
- `process.runtime.name`
- `process.runtime.version`
- `os.type`
- `os.version`
- `host.arch`
- `prompt_preflight.debug_log_dir`

### Spans

| Span | Kind | Parent | Key attributes |
| --- | --- | --- | --- |
| `session` | INTERNAL | none | extension, VS Code, Node, platform, workspace roots, settings snapshot |
| `review.quick` | INTERNAL | session | `prompt_preflight.mode`, provider, model, effort, prompt hash, prompt chars, attempt |
| `review.deep` | INTERNAL | session | same as quick |
| `review.improve` | INTERNAL | session | prompt hash, model, effort, question count |
| `health.check` | INTERNAL | review | CLI path, ok, error code, RTT |
| `llm.call` | CLIENT | review | `gen_ai.*`, provider, mode, generation method, effort, timeout, RTT, exit code, signal, cost |

`llm.call` carries span events for `request`, `process`, `stdin`, `stdout`, `stderr`, `response`, and `error`.
The full request and response payloads are log records, not span attributes.
Span attributes stay small and queryable.

### Standard model attributes

Use OpenTelemetry GenAI names where they exist:

- `gen_ai.system`: `anthropic`
- `gen_ai.operation.name`: `chat`
- `gen_ai.request.model`
- `gen_ai.response.model`
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`

Use these domain attributes for the remaining mechanics:

- `prompt_preflight.mode`: `quick`, `deep`, `improve`
- `prompt_preflight.provider`: `claude`
- `prompt_preflight.generation_method`: `cli`
- `prompt_preflight.thinking_effort`
- `prompt_preflight.timeout_ms`
- `prompt_preflight.rtt_ms`
- `prompt_preflight.prompt_hash`
- `prompt_preflight.prompt_chars`
- `prompt_preflight.attempt`
- `prompt_preflight.exit_code`
- `prompt_preflight.signal`
- `prompt_preflight.killed`
- `prompt_preflight.cost_usd`
- `prompt_preflight.error_code`
- `prompt_preflight.retryable`

### Logs

Each log record has `event.name` and `event.domain = prompt-preflight`.
The severity follows OpenTelemetry:

| Signal | Severity | Payload |
| --- | --- | --- |
| `session.start` | INFO | session snapshot |
| `session.end` | INFO | uptime |
| `config.change` | INFO | key, old value, new value |
| `ui.input` | DEBUG | chars, words, score, level, finding count, question count, prompt hash |
| `ui.action` | INFO | action, mode |
| `ui.send` | INFO | target, prompt hash, score, level, study-log enabled, full text |
| `review.health` | INFO or ERROR | CLI path, ok, error code, RTT |
| `llm.request` | INFO | system prompt, user prompt, model, effort, method, timeout, prompt hash |
| `llm.process` | DEBUG | argv, cwd, pid, stdin chars |
| `llm.stdout` | DEBUG | full stdout |
| `llm.stderr` | WARN | full stderr |
| `llm.response` | INFO | full response text, RTT, usage, cost |
| `llm.error` | ERROR | error name, message, stack, code, signal, killed, timed out, aborted, parse error |
| `review.parsed` | INFO | verdict, issue and question counts, improved prompt, usage |
| `review.error` | ERROR | mapped code, action, retryable, message |
| `storage.studyLog` | INFO | enabled, event |
| `storage.debug` | INFO | rotate or clear, file |

## JSONL record schema

One JSON object per line.
Every record has `schemaVersion`, `recordType`, and `ts`.
`recordType` is `span` or `log`.

Span record:

```json
{
  "schemaVersion": 1,
  "recordType": "span",
  "ts": "2026-11-18T12:00:00.000Z",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": "a3ce929d0e0e4736",
  "name": "llm.call",
  "kind": "CLIENT",
  "startTimeUnixNano": "1763467200000000000",
  "endTimeUnixNano": "1763467201234000000",
  "durationMs": 1234,
  "status": { "code": "OK" },
  "attributes": {
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": "sonnet",
    "prompt_preflight.mode": "quick",
    "prompt_preflight.thinking_effort": "medium",
    "prompt_preflight.timeout_ms": 120000,
    "prompt_preflight.rtt_ms": 1234
  },
  "events": [
    { "name": "request", "timeUnixNano": "1763467200000000000", "attributes": {} }
  ],
  "resource": {},
  "instrumentationScope": { "name": "prompt-preflight", "version": "0.1.0" }
}
```

Log record:

```json
{
  "schemaVersion": 1,
  "recordType": "log",
  "ts": "2026-11-18T12:00:00.000Z",
  "timeUnixNano": "1763467200000000000",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "severityNumber": 9,
  "severityText": "INFO",
  "body": "llm.request",
  "attributes": {
    "event.name": "llm.request",
    "event.domain": "prompt-preflight",
    "gen_ai.request.model": "sonnet",
    "prompt_preflight.thinking_effort": "medium",
    "llm.request.system": "...",
    "llm.request.user": "..."
  },
  "resource": {},
  "instrumentationScope": { "name": "prompt-preflight", "version": "0.1.0" }
}
```

## User-facing surface

The colored surface is a VS Code `LogOutputChannel` named `Prompt Preflight Debug`.
It uses the native log levels for color:

- DEBUG: process, stdin, span lifecycle.
- INFO: session, request, response, parsed review, UI actions.
- WARN: stderr output, health failures.
- ERROR: model and review errors.

Each line is prefixed with the time, a short trace id, and a phase label, for example:

```text
12:00:00.000 [4bf92f35] [LLM->] [quick] [claude/sonnet/medium] prompt=1842 chars
12:00:01.234 [4bf92f35] [LLM<-] [ok] rtt=1234ms tokens=120/48 cost=$0.0012
12:00:01.234 [4bf92f35] [LLM!!] [provider-missing] Claude Code CLI not found
```

The output channel shows a bounded preview of large payloads.
The JSONL file always contains the full payload.
The channel follows the VS Code log level; set it to Debug to show process, stdin, input, and span lifecycle lines.

## Lifecycle

- On activation, read `promptPreflight.debug` and `promptPreflight.debugLogDir`.
- If debug is on, ask for the first-enable warning, then create the providers, exporters, writer, and output channel.
- Hold a session span for the activation lifetime.
- On a relevant setting change, close the current trace and create a new one.
- On deactivate, end the session span, flush both providers, close the writer, and dispose the output channel.
- All VS Code resources are registered through `context.subscriptions` or closed by the controller.

## Commands

- `promptPreflight.openDebugLog`: show the colored output channel. If debug is off, show a message.
- `promptPreflight.openDebugLogFile`: open the current `llm-trace.jsonl` if it exists.
- `promptPreflight.clearDebugLog`: close the writer, delete `llm-trace*.jsonl` in the resolved directory, and reopen when debug is on.

`promptPreflight.clearHistory` keeps the debug trace and the study log.

## Privacy

- Debug is opt-in and off by default.
- The request log stores the final request after context policy and redaction. It does not store pre-redaction text.
- The response log stores the raw model response.
- The file is local, mode `0600`, and is never uploaded.
- The first enable warning names the file location and the raw-payload behavior.
- The trace is separate from the study log and from `reviews.jsonl`, `sends.jsonl`, `drafts.jsonl`, and `questions.jsonl`.
- The trace is fail-soft. Logger, exporter and channel failures are dropped and never fail a review.
- POSIX modes are `0700` for the directory and `0600` for files. Windows ACLs are host-controlled; `path.win32` path handling is unit-tested.

## Acceptance

- `promptPreflight.debug` is false by default and creates no trace when false.
- `promptPreflight.debugLogDir` defaults to `<context.globalStorageUri>/debug`.
- Enabling debug writes `llm-trace.jsonl` with span and log records.
- Each LLM call records mode, provider, model, effort, generation method, timeout, RTT, stdout, stderr, exit code, usage, cost, and error fields.
- The JSONL records carry OTel trace and span ids and standard `gen_ai.*` attributes.
- The output channel shows labeled lines at the correct severity.
- Rotation keeps 5 files at 10 MB.
- The debug log survives `clearHistory` and is removed by `clearDebugLog`.
- The study log remains independent.
- Typecheck, tests, build, and e2e pass.

## Status

- Branch: `feat/debug-observability`.
- Tests: C36-C39 and E12; 551 unit tests; 12 of 12 e2e tests.
- Adversarial review: `docs/reviews/debug-observability.md`.
- PR: draft, not merged.
- The current panel review, LLM, UI and send paths are traced. Context, session and language-tool signals are reserved for the #43, #46 and #47 wiring.
