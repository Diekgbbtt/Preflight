# LSP parity record (ticket #37)

The language context sources use the agent tools in `extension/src/codeTools.ts`.
The tools call the installed language providers through the adapter in
`extension/src/vscodeCodeTools.ts` and fall back to the bundled `rg`.
A measured gap becomes a new ticket; nothing here is fabricated.

## Environment facts (measured on this machine, 2026-11-17)

- VS Code 1.146.0 (arm64) is installed at `/Applications/Visual Studio Code.app`.
- The installed app signature is invalid: `codesign --verify --deep --strict` reports "code or signature have been modified".
- The VS Code binary aborts with `SIGABRT` before any output in the current agent sandbox.
- An ad-hoc signed copy also aborts, so the sandbox is the likely blocker, not only the signature.
- The `e2e` suite mounts the extension and opens the sample workspace when VS Code can launch.
- `rg` is bundled: `@vscode/ripgrep` 1.18.0 copies ripgrep 15.0.0 to `extension/dist/rg`.
- The system `rg` is not required.
- The text-search fallback therefore works with the bundled binary; a missing binary omits `unsupported`.
- The relevant editor extensions for the manual Python and Rust rows are `ms-python.python`, `ms-python.vscode-pylance`, and `rust-lang.rust-analyzer`.

## Automated measurement

Run this from a normal GUI Terminal:

```bash
npm run e2e
```

The suite includes:

- E7: the built-in TypeScript provider returns a `greet` symbol from `src/greet.ts`.
- E8: an absent workspace symbol (`MissingNeedle`) falls over to the bundled `rg` and finds `src/needle.ts`.

The suite output is the measurement record.
The e2e suite passed 9/9 on 2026-11-17, including E7 (TypeScript symbols) and E8 (rg fallback).

## Parity table

| Language | Provider available | Symbol kind | Location precision | Truncation | Measured | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript | yes (e2e E7) | `Function` for `greet` (e2e E7) | not measured | not measured | **partly measured** | E7 and E8 passed on 2026-11-17. Location precision and truncation remain manual. |
| Python | `ms-python.python` + `ms-python.vscode-pylance` installed | not measured | not measured | not measured | **not measured** | Run the manual steps in a real window. |
| Rust | `rust-lang.rust-analyzer` installed | not measured | not measured | not measured | **not measured** | Run the manual steps in a real window. |

Reason for "not measured": the agent sandbox kills the VS Code process with
`SIGABRT` before the extension host starts.
The e2e suite and the manual steps are ready; they must run in a normal window.

## Manual steps to fill the table

For each of TypeScript, Python, and Rust:

1. Open a VS Code window on a workspace containing a file in the language with a known identifier used in more than one file.
2. Confirm the language status shows a language server running.
3. Open the file and place the cursor on the known identifier.
4. Run `npm run e2e` for the automated TypeScript row.
5. For Python and Rust, call the extension tools through the facade or run the equivalent provider commands:
   - `vscode.executeDocumentSymbolProvider` - count symbols, note the kinds and whether children are nested.
   - `vscode.executeDefinitionProvider` - count locations and note the range precision.
   - `vscode.executeReferenceProvider` - count references and note any outside the workspace.
6. Compare the tool output with the provider output.
7. Record language, provider available, symbol kind names, location precision, truncation, measured date, and notes.

Delete a "not measured" row only when every field comes from a real run.

## Fallback behavior when no server answers

- A tool with a query falls back to the bundled `rg` when the LSP result is empty.
- The fragment keeps the source id and priority and records provenance kind `text-search`.
- A policy-hidden result never falls back.
- Diagnostics never fall back.
- A missing bundled binary omits `unsupported`; grep is never substituted.
- A measured gap here should be recorded above and turned into a new ticket.
