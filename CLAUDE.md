# Agent instructions

Prompt Preflight: feedback on coding-agent prompts before they are sent. See README.md for the idea and layout.

## Rules

- Rule logic lives in `core/` and must stay free of VS Code imports, so the hook and tests can use it.
- Every change to rules needs a corpus line in `core/test/corpus.jsonl` (both prompts that should be flagged and prompts that should pass). False alarms matter as much as misses.
- Keep tier 1 (rules) instant: no I/O, no model calls inside `analyze()`.
- Model calls go through the `ModelRunner` interface (`core/src/review.ts`); never invent facts in improved prompts, use `[placeholders]`.
- Webview script `extension/media/panel.js` is plain JS (no build). Keep the textarea and `.backdrop` CSS metrics identical or highlights drift.
- Feedback text: short, plain English, tells the user what to add. No jargon.

## Check before finishing

```bash
npm run typecheck && npm test && npm run build
```

## Work tracking

Open tasks are GitHub issues in tolipp/prompt-preflight.
