# PR #49 review feedback

**PR:** https://github.com/Diekgbbtt/Preflight/pull/49
**Review event:** `pullrequestreview-5936368666`
**Verdict:** refused
**Review body:** "refused -- comments bounded to single faulty files"
**Head under review:** `363ea9f07e9c268c7a5f06ea56e2c7032b7c270a`
**Recorded:** 2026-11-17

This document records the review exactly before any fix is designed.
It is the input to the fix plan, not a defence of the current code.

## 1. Owner answers to the four open questions

### 1.1 LSP and language context

The language-context design will be refactored.
More information follows.
The refactor must use an off-the-shelf semantic abstraction, not a new LSP built from scratch.
The named library is `microsoft/vscode-languageserver-node`.
The selected packages are:

- `vscode-languageserver` for the server-side connection, request handlers, lifecycle and capabilities.
- `vscode-languageserver-protocol` for typed LSP requests, responses, notifications and capabilities.
- `vscode-jsonrpc` for the JSON-RPC connection, transport, typed handlers and cancellation.
- `vscode-languageserver-types` for the standard semantic data structures.

The split of responsibility is:

- Microsoft library: protocol implementation and RPC infrastructure.
- VS Code adapter: translate editor capabilities into LSP operations.
- Agent middleware: expose more expressive, context-oriented tools.

The agent middleware is the part to implement.
Each tool maps to an LSP capability implemented with the library's protocol infrastructure.
The tools are read-only indexing and filtering access tools.

### 1.2 Ripgrep

`rg` must be operationalised through its library, not through a system `rg` CLI.
The library is assumed to remove the missing system dependency.
The text-search path must coexist with the new codebase access tools.
When the new tools cannot find the data the agent is looking for, the agent must fail over to text search.

### 1.3 Handover

The handover must cover, concretely, the seams that the panel must use to consume the data.
It is not enough to publish types in separate sections.
The panel-facing calls, inputs, outputs, and wiring points must be explicit.

### 1.4 Tests, Windows, and Codex

More tests are required.
Windows must be covered.
The Codex `event_msg` field assumption is a fatal defect.
Required dependencies must be installed, or named to the owner for manual installation.

## 2. Inline review comments

### 2.1 `core/src/schema.ts:41` - `ScoreReport.thinkingEffort`

**Exact comment:** "assumptions on provider thinking efforts values, rather loosen it and projcet the value in the inference request"

**Current code:**

```ts
thinkingEffort: "low" | "medium" | "high";
```

**Required change:**

- Remove the hard-coded three-value union from the score and metadata shapes.
- Loosen the type so a provider can publish its own effort values.
- Project the provider-native value into the inference request instead of translating an assumed enum.
- Update `ModelProfile`, `Config`, the settings shape, and the Claude adapter to match.
- Record the exact provider values in the handoff, not an assumed union.

**Affected contracts:** #40, #39.

### 2.2 `core/src/schema.ts:50` - `ScoreMeta.thinkingEffort`

**Exact comment:** "commnets above apply also here"

**Required change:**

- Apply the same loosening to `ScoreMeta`.
- Keep `ScoreReport` and `ScoreMeta` structurally aligned.

**Affected contracts:** #40, #39.

### 2.3 `core/src/schema.ts:77` - `DeepReview.improvedPrompt`

**Exact comment:** "deep review should not contain the improved prompt -- it should actually be a separate element, triggered by a specific user action, enabled only after generating at least one deepReview with questions"

**Current code:**

```ts
export interface DeepReview {
  ...
  improvedPrompt: string;
  ...
}
```

**Required change:**

- Remove `improvedPrompt` from `DeepReview`.
- Remove `improvedPrompt` from the deep reply schema and deep system prompt.
- Add a separate improved-prompt result type and a separate request builder or operation.
- The improved-prompt action is triggered by a specific user action.
- The action is enabled only after at least one deep review with at least one question.
- Define how the action uses the deep questions and any answers.
- Update persistence and panel call sites so a deep review never carries an improved prompt.

**Affected contracts:** #40, #35, #13, #46, #47.

### 2.4 `core/src/schema.ts:148` - `MAX_ISSUES` and `MAX_QUESTIONS`

**Exact comment:** "increse the ceiling, let's say 20 for both"

**Current code:**

```ts
const MAX_ISSUES = 3;
const MAX_QUESTIONS = 3;
```

**Required change:**

- Raise both ceilings to 20.
- Update the reply schemas, prompt prose, parser caps, and tests.
- Keep the option cap at three unless the owner says otherwise.

**Affected contracts:** #40.

### 2.5 `core/src/schema.ts:206` - `parseDeepReview` score

**Exact comment:** "score only provided via quick feedbacks, asynchronously"

**Current code:**

```ts
score: parseScore(text, prompt, meta),
```

**Required change:**

- Deep review returns no score.
- Remove `score` from `DeepReview`.
- Remove dimensions, confidence, and the score request from the deep reply schema and deep prompt.
- Keep scoring on the quick path only, asynchronously.
- Remove `"deep"` from the score source union unless a future contract re-introduces it.
- Update persistence, prices, and tests that assume a deep score.

**Affected contracts:** #40, #35, #42, #46.

### 2.6 `extension/src/contextSources.ts:1` - implicit editor context

**Exact comment:** "the currently active/opened files in the editor, or the 'user selection', should not be a first-class context files -- pure assumption on the user opening the files that needs to be edited. Whereas the prompt may reference specific files with the '@' symbol -- these end plain in the feedback agen context. the cosntructs here can be slightly adapted and resude for this use case."

**Required change:**

- Remove active editor, selection, and open editors as first-class context sources.
- Add explicit `@`-reference resolution from the draft.
- Resolve each referenced file against the owning workspace folder.
- Include the referenced file text as context, subject to the privacy policy and redaction.
- Reuse the existing folder-resolution and path-safety constructs where they fit.
- Define the exact `@` syntax, multi-root resolution, missing-file behaviour, duplicate references, and caps.

**Affected contracts:** #36, #37, #41.

### 2.7 `extension/src/languageContext.ts:1` - bespoke LSP layer

**Exact comment:** "likely a fundamental design smell: built an LSP on top of vscode lanague server, and not abstracted it to agentic tools with good semantics"

**Required change:**

- Replace the bespoke `LanguageApi` semantics with an agent-facing tool layer.
- Use the named `vscode-languageserver-node` packages for protocol and RPC infrastructure.
- Keep the VS Code adapter as the translator from editor capabilities to LSP operations.
- Expose read-only, context-oriented tools with explicit inputs, outputs, caps, and failure modes.
- Define the fallback to text search when a tool finds no data.
- Add tests for the middleware and the adapter, plus e2e coverage in a real VS Code window.

**Affected contracts:** #37, #43, #46, #47.

## 3. Resolved decisions

These decisions were taken after the review and are binding for the fix plan.

### 3.1 LSP topology

- Use an in-process agent middleware over the LSP data and protocol types.
- Use `vscode-languageserver-types`, `vscode-languageserver-protocol`, and `vscode-jsonrpc`.
- Do not add `vscode-languageserver`; it is server-side infrastructure and the selected topology has no LSP server.
- Do not add `vscode-languageclient`; the VS Code adapter calls the editor language providers directly.
- The adapter translates editor capabilities into LSP operations.
- The middleware exposes read-only context tools with explicit inputs, outputs, caps, and failure modes.

### 3.2 Ripgrep

- Use `@vscode/ripgrep` as the source of the bundled `rg` binary.
- Copy the platform binary at build time so the CommonJS extension bundle does not import the ESM package at runtime.
- Text search coexists with the LSP tools.
- A tool that finds no data falls back to text search when it has a query.
- `textDocument/diagnostic` has no text-search fallback because text search cannot produce diagnostics.

### 3.3 Improved prompt

- `DeepReview` does not contain the improved prompt.
- The improved prompt is a separate `ImprovedPrompt` result and a separate model request.
- The action is enabled only after a deep review with at least one question.
- The request uses the original prompt, the deep issues, the deep questions, and any answered questions.
- Unknown details are written as `[placeholders]`.

### 3.4 Explicit `@` file context

- Active editor, selection, and open editors are no longer first-class context sources.
- The draft may reference files with `@path`, for example `@src/greet.ts`.
- Referenced file text enters the context bundle as the `prompt-files` source.
- `@` files are included under `prompt-files` and `workspace`; `off` excludes them.
- `git-diff` and `test-command` remain.
- The existing privacy exclusions, redaction, folder resolution, and path-safety constructs are reused.

### 3.5 Test environment

- E2E runs against the installed VS Code app at `/Applications/Visual Studio Code.app/Contents/MacOS/Code`.
- No `@vscode/test-electron` dependency is added.
- Windows coverage uses pure `path.win32` tests and a documented Windows e2e script.
- Codex fixtures are copied from real local sessions under `~/.codex/sessions` and scrubbed.
- The shell has no network access, so the owner installs the new npm packages manually.

## 4. Review summary

- The refusal is bounded to the seven comments above.
- Comments 2.1 to 2.5 are type and contract defects in `core/src/schema.ts`.
- Comment 2.6 is a context-design defect in `extension/src/contextSources.ts`.
- Comment 2.7 is a language-context design defect in `extension/src/languageContext.ts`.
- The owner separately requires real e2e coverage, Windows coverage, and a real Codex `event_msg` fixture.
