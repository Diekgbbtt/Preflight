# Debug observability adversarial review

**Scope:** `feat/debug-observability` against `main`
**Reviewer:** implementing agent, adversarial pass
**Date:** 2026-11-18

## Verdict

The debug trace meets the five decisions: OTel API plus a custom JSONL exporter, full request and response payloads, full e2e coverage of the current panel path, a colored `LogOutputChannel` with separate commands, and a machine-agnostic directory with 10 MB x 5 rotation.

The trace is fail-soft. A trace, exporter or channel failure does not fail a review.

## Owner requirements

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Use established standards | closed | `@opentelemetry/api` 1.9.0, `api-logs` 0.57.0, `sdk-trace-base` 1.30.0, `sdk-logs` 0.57.0, `resources` 1.30.0, `core` 1.30.0. `gen_ai.*` and `prompt_preflight.*` attributes. |
| Logs and traces, not one flat signal | closed | `session`, `review.*`, `health.check` and `llm.call` spans; `llm.request`, `llm.response`, `llm.error`, `review.*`, `ui.*` and `storage.*` log records. |
| Full LLM request and response packets | closed | `llm.request.system`, `llm.request.user`, `llm.stdout`, `llm.stderr` and `llm.response.text` are stored after policy and redaction. |
| Thinking effort, generation method, timeout, RTT and more | closed | `prompt_preflight.thinking_effort`, `generation_method`, `timeout_ms`, `rtt_ms`, `prompt_hash`, `exit_code`, `signal`, `killed`, `timed_out`, `aborted`, `cost_usd`, `usage.*`. |
| Debug setting off by default | closed | `promptPreflight.debug` default `false`; no providers, writer or channel when off. |
| Machine-agnostic log location | closed | `promptPreflight.debugLogDir`; empty resolves to `<context.globalStorageUri>/debug`; relative paths resolve under it; absolute paths are kept. |
| Separate from the study log | closed | `llm-trace.jsonl` under the debug directory; `study-log.jsonl` remains separate; `clearHistory` keeps both. |
| Colored labels | closed | `LogOutputChannel` with native severity colors and phase labels (`[LLM REQ]`, `[LLM RES]`, `[SESSION]`, `[STORE]`). |
| Lifecycle through VS Code seams | closed | `context.subscriptions` for the controller; `deactivate` awaits shutdown; config changes rebuild the trace; the channel is disposed with the trace. |
| Rotation | closed | 10 MB per file, 5 files, `.llm-trace.history`; current file is `llm-trace.jsonl`; rotations are `llm-trace.N.jsonl`. |
| Privacy | closed | File mode `0600`, directory `0700` on POSIX, first-enable warning under `promptPreflight.debugNotice.v1`, no upload. |
| TDD and e2e | closed | C36-C39 unit assertions and E12 live extension test. |

## Findings fixed during the adversarial pass

- The first e2e attempt raced the webview `ready` event. The panel-ready `onInput` aborted the first quick review. The test now focuses the panel and waits for readiness before selecting the text.
- The e2e cannot answer a modal. The extension API exposes `acceptNotice()` so the test can pre-accept the debug warning without weakening the production warning.
- A trace or channel failure could have propagated into `runReview`. The controller, logger, span event, exporter and channel boundaries now catch and drop debug errors.
- The debug path resolver uses the host `path` by default and accepts an injected path API. `path.win32` cases cover drive, relative and absolute paths.
- The JSONL writer creates the extension directory and sets file mode `0600`; the rotation history is removed by `clearDebugLog`.
- The e2e verifies that `llm.request` and `llm.response` share the `llm.call` trace and span ids, and that the span is `CLIENT` and `OK`.

## Residual risks

- The OTel 1.x trace package is deprecated in favor of the 2.x line. The 2.x line peers with `@opentelemetry/api` 1.10 and the logs 3.x line, while the 1.x logs line peers with API below 1.10. The pinned set is the compatible stable line for a Node 18 extension host. Revisit when the trace and logs majors align.
- The OTel Logs API is still experimental. The JSONL exporter is custom and owns the file schema.
- Full payload logging is sensitive by design. It is opt-in, local and mode `0600`. Windows ACL behavior is not measured live.
- The live Windows debug trace is not measured. The path resolver has `path.win32` tests; the file writer uses host Node APIs.
- The current panel path is fully traced. Context assembly, session discovery and LSP tool signals are reserved for the #43, #46 and #47 wiring; those modules are not on the current panel path.
- The four review, send, draft and question JSONL repositories remain unwired. The debug trace does not replace them.
- The output channel follows the VS Code log level. Process, stdin, input and span lines are hidden until the channel level is Debug; the JSONL file always has them.

## Gate status

- `npm run typecheck`: passed three times.
- `npm test`: 24 files, 551 tests passed three times.
- `npm run build`: passed three times; extension bundle is about 526 KB.
- `npm run e2e`: 12 of 12 tests passed on 2026-11-18.
- PR: draft, not merged.
