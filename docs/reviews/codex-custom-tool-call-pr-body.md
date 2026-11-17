# Fix Codex custom tool calls

This PR fixes the Codex session parser so it reads the `custom_tool_call` and `custom_tool_call_output` events that current Codex sessions emit for `apply_patch`.

## Root cause

`parseCodexSession` handled `event_msg.item_completed` `CommandExecution` and `FileChange`, and `response_item.function_call`.
It did not handle `response_item.custom_tool_call` or `custom_tool_call_output`.
An audit of 73 local Codex sessions found 359 `custom_tool_call` events, all `apply_patch`, and 108 matching `FileChange` events.
The parser dropped those calls and could miss changed files.

## Change

- Parse `custom_tool_call` with `status`, `call_id`, `name`, and `input`.
- Parse `custom_tool_call_output` with `call_id` and `output`.
- Extract every `*** Update|Add|Delete File:` path from an `apply_patch` input.
- Keep a failed call failed when the output has no `is_error`.
- Dedupe a `custom_tool_call` and a `FileChange` with the same id.
- Add `extension/test/fixtures/codex/session-custom-tool.jsonl`.

## Verification

- `npm run typecheck`: passed.
- `npm test`: 20 files, 527 tests passed.
- `npm run build`: passed.
- `npm run e2e`: 11 of 11 tests passed on 2026-11-17, including E11.
- Re-audit: 359 of 359 custom calls parsed; 2,799 unique tool calls; 0 duplicate FileChange calls.

## Stack

This PR is based on `lane-1/control-plane` and is stacked on PR #49.
Do not merge #49 without this fix.
The panel wiring remains #43, #46, and #47.
The live Windows run remains manual.
