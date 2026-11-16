# LSP parity record (ticket #37)

The language context sources delegate to installed language servers through
`vscode.commands.executeCommand`. This record shows, per language, whether the
delegation is good enough or where it falls short. A measured gap becomes a new
ticket; nothing here is fabricated.

## Environment facts (measured on this machine, 2026-11-16)

- VS Code 1.146.0 (arm64) installed at `/Applications/Visual Studio Code.app`.
- Installed extensions (`code --list-extensions`), relevant rows:
  `ms-python.python`, `ms-python.vscode-pylance`, `rust-lang.rust-analyzer`,
  `haskell.haskell`, `fwcd.kotlin`.
- `ripgrep` (`rg`) is not installed. The text-search fallback therefore omits
  with `unsupported` until `rg` is installed; no grep substitution.
- No interactive VS Code window was available to the implementing agent, so
  provider output could not be captured automatically.

## Parity table

Columns per the ticket: language, provider available, symbol kind, location
precision, truncation, measured or not, notes.

| Language | Provider available | Symbol kind | Location precision | Truncation | Measured | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| TypeScript | not measured | not measured | not measured | not measured | **not measured** | No language server ships with VS Code for TS without a workspace open; no interactive window was available to run `executeDefinitionProvider` and record results. |
| Python | not measured | not measured | not measured | not measured | **not measured** | Pylance (`ms-python.vscode-pylance`) is installed, so a real window should answer; the agent could not run an interactive session to capture its output. |
| Rust | not measured | not measured | not measured | not measured | **not measured** | `rust-lang.rust-analyzer` is installed, the third language per the ticket; same capture blocker. |

Reason for "not measured": running `vscode.executeDefinitionProvider`,
`vscode.executeReferenceProvider`, and `vscode.executeDocumentSymbolProvider`
requires an interactive VS Code window with an open document and a live
language server. The `code` CLI exposes no headless command execution for
provider calls. Do not trust this table as evidence until the manual steps
below are run.

## Manual steps to fill the table

For each of TypeScript, Python, and Rust:

1. Open a VS Code window on a workspace containing a file in the language with
   a known identifier (for example a function or class used in more than one
   file). Confirm the language status shows a language server running.
2. Open the file, place the cursor on the known identifier.
3. Run the VS Code commands and record the output:
   - `Developer: Go to Definition` / `vscode.executeDefinitionProvider` -
     count the locations, note the range precision (start position only, or a
     full range).
   - `Go to References` / `vscode.executeReferenceProvider` - count the
     references, note whether any point outside the workspace.
   - `Go to Symbol in Editor...` / `vscode.executeDocumentSymbolProvider` -
     note the symbol kinds shown and whether children are nested.
4. Run the same queries through the extension's language sources (the
   `symbols`, `references`, and `definitions` sources with
   `promptPreflight.context.includeCode` on `workspace`) and compare the
   fragment lines against step 3.
5. Record per language: provider available (yes/no), symbol kind names
   observed, location precision (line:col start only vs full range),
   truncation (whether the 20/50/100 caps cut real results), and any missing
   provider.

Expected fields to record: language, provider available, symbol kind, location
precision, truncation, measured date, notes. Add a measured row per language
and delete the "not measured" row only when the fields are filled from a real
run.

## Fallback behavior when no server answers

If a language has no language server, the probe returns false for that
capability and the source falls back to `rg` text search with the fragment
marked provenance kind `text-search`, keeping the same source id and priority.
With `rg` missing the source omits with `unsupported`; grep is never
substituted. A measured gap here (for example a language where the fallback is
unusable) should be recorded above and turned into a new ticket.
