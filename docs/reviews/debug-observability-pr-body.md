# Debug observability

This PR adds an opt-in OpenTelemetry debug trace for model interactions.
It is separate from the study log and from the review, send, draft and question JSONL files.

## What changed

- `promptPreflight.debug` boolean, default `false`.
- `promptPreflight.debugLogDir` string, default `""`, resolving to `<context.globalStorageUri>/debug`.
- `llm-trace.jsonl` with 10 MB x 5 rotation, mode `0600` for files and `0700` for the POSIX directory.
- OpenTelemetry API and SDK primitives with a custom JSONL span and log exporter.
- Spans: `session`, `review.quick`, `review.deep`, `health.check`, `llm.call`.
- Logs: request, process, stdin, stdout, stderr, response, error, review parsing, UI, storage.
- Standard `gen_ai.*` attributes and `prompt_preflight.*` domain attributes.
- Colored `Prompt Preflight Debug` output channel with phase labels.
- Commands: `openDebugLog`, `openDebugLogFile`, `clearDebugLog`.
- First-enable warning stored under `promptPreflight.debugNotice.v1`.
- Full request is the final post-redaction request; the response is raw.
- Core `LlmTrace` seam instrumented in `claudeCli`; panel review, health, UI and send paths wired.
- A debug failure is dropped and never fails a review.

## Verification

- `npm run typecheck`: passed three times.
- `npm test`: 24 files, 551 tests passed three times.
- `npm run build`: passed three times; extension bundle is about 526 KB.
- `npm run e2e`: 12 of 12 tests passed on 2026-11-18, including E12.
- E12 runs the built extension, the panel check-selection path, the fake Claude CLI and a temp debug directory.
- `path.win32` unit cases cover the default, relative and absolute debug paths.

## Notes

- The OTel trace 1.x and logs 0.57 lines are pinned to compatible peer versions for the Node 18 extension host.
- The current panel path is fully traced. Context, session and language-tool signals are reserved for the #43, #46 and #47 wiring.
- The four review, send, draft and question JSONL repositories remain unwired.
- Draft PR. Do not merge without owner review.
