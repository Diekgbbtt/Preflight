# Contributing

Use Node.js 20+ and run all commands from the repository root. This npm workspace contains `core`, `extension` and `hook`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

For a focused core check, use `npm test -- core/test/analyze.test.ts`. `npm run package` builds the extension and creates its VSIX. Open the repo in VS Code and press F5 with **Run Extension** to test the extension host. For edit/build cycles, `npm run watch -w extension` rebuilds the extension bundle; reload the development window to load it. Webview JavaScript and CSS are served directly without a build step.

## Boundaries

Read [CLAUDE.md](CLAUDE.md) and [the current architecture](docs/ARCHITECTURE.md). Keep rules synchronous and free of I/O. Keep `core` free of VS Code imports. Inject a `ModelRunner` for model tests; the default checks should not require a paid model call. Never fill unknown details in suggested prompts with invented facts.

Every rule change needs corpus cases for prompts that should clarify and prompts that should pass. Each non-comment line in `core/test/corpus.jsonl` has a unique `id`, a `prompt`, and `should_clarify`; `expected_level` and `expected_rules` are optional. The corpus test supplies a synthetic path lookup that treats references containing `missing` as absent; it is not a real filesystem test.

Keep textarea/backdrop CSS metrics aligned when changing highlights. Validate host/webview and terminal changes in real VS Code, following [issue #2](https://github.com/Diekgbbtt/Preflight/issues/2). Use fake credentials and prompts in fixtures and screenshots.

## Review and tracking

Open work lives in [GitHub issues](https://github.com/Diekgbbtt/Preflight/issues). The architecture roadmap is [#28](https://github.com/Diekgbbtt/Preflight/issues/28); it describes planned APIs, not the current implementation. Check individual issue dependencies before starting. [Improvement suggestions](docs/IMPROVEMENTS.md) connect source findings to existing tickets.

Keep changes focused. Describe the user-visible behavior, linked issue, checks run and any remaining manual validation. Before finishing, run `npm run typecheck`, `npm test` and `npm run build`. Update usage documentation when commands, settings, gate behavior or data collection change.
