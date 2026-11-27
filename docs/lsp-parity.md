# LSP parity record (ticket #37)

The language context sources use the agent tools in `extension/src/codeTools.ts`.
The tools call the installed language providers through the adapter in
`extension/src/vscodeCodeTools.ts` and fall back to the bundled `rg`.
A measured gap becomes a new ticket; nothing here is fabricated.

## Environment facts (measured on this machine, 2026-11-17)

- VS Code 1.146.0 (arm64) is installed at `/Applications/Visual Studio Code.app`.
- The installed app signature is invalid: `codesign --verify --deep --strict` reports "code or signature have been modified".
- The VS Code binary aborted with `SIGABRT` before any output in the current agent sandbox.
- An ad-hoc signed copy also aborted, so the sandbox was the likely blocker, not only the signature.
- Update 2026-11-27: VS Code launches and the e2e suite passes 14/14 in this environment again; the 2026-11-17 `SIGABRT` fact no longer reproduces here.
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
The e2e suite passed 11/11 on 2026-11-17, including E7 (TypeScript symbols) and E8 (rg fallback). E11 is the Codex custom tool call test, not an LSP test.
On 2026-11-27, on the `ticket/61-search-cap-privacy` branch, the suite ran in this environment and passed 14/14, including E8 (rg fallback) through the #61 scoped, canonically ordered search path. The #61 change is unit-verified (615 tests) and walkthrough-verified by E8.

## Parity table

| Language | Provider available | Symbol kind | Location precision | Truncation | Measured | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript | yes (e2e E7) | `Function` for `greet` (e2e E7) | not measured | not measured | **partly measured** | E7 and E8 passed on 2026-11-17. Location precision and truncation remain manual. |
| Python | `ms-python.python` + `ms-python.vscode-pylance` installed | not measured | not measured | not measured | **not measured** | Run the manual steps in a real window. |
| Rust | `rust-lang.rust-analyzer` installed | not measured | not measured | not measured | **not measured** | Run the manual steps in a real window. |

Reason for "not measured": as of 2026-11-17 the agent sandbox killed the VS Code
process with `SIGABRT` before the extension host started; on 2026-11-27 VS Code
launches again in this environment, so the manual Python and Rust steps can run
in a normal window.

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

## Text-search privacy and determinism (ticket #61)

- The code-tools seam computes the allowed path set from the policy and passes it to the text-search port as a plain search scope. Under `prompt-files`, `rg` receives exactly the referenced prompt files, so disallowed files are never opened and can never crowd out allowed matches. Under `workspace`, the scope is the whole tree and the `isAllowed` filter keeps holding at the seam.
- An empty allowed scope (`off`, or `prompt-files` with no allowed paths) returns `excluded` without opening anything.
- The port returns the complete match list, bounded by the per-file `rg` cap and the exec buffer. The tool filters, sorts canonically by path, line, and character, then caps. Two identical searches on an unchanged tree return the same set in the same order.
- The adapter drops nonexistent path arguments before invoking `rg`, so a stale prompt file shrinks the scope instead of failing the whole run.
- The `listFiles` fallback carries the same shape: scope, filter, alphabetical sort, cap.
- Decisions: `docs/adr/0001-text-search-searches-only-policy-allowed-paths.md`, `docs/adr/0002-the-tool-owns-filter-order-and-cap.md`, `docs/adr/0003-determinism-contract-is-same-set-and-same-order.md`.
