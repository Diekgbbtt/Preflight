# Prompt Preflight

Preflight (working name) gives feedback on coding-agent prompts before they're sent. We don't try to improve the agent's execution itself (Codex/Claude Code are far ahead there).

Vague prompts make agents guess, loop and spend tokens. Preflight checks the prompt while the user writes it, asks for missing goals, context and success criteria, and only then hands it to Claude Code. Users write a prompt the agent can solve in one run, and learn what a complete prompt looks like.

## Cheap checks first

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Rules | every keystroke | `core/src/analyze.ts`: highlights, rule findings, a deterministic pre-check score, and questions | free |
| 2. Quick review | after a typing pause | one model call that returns the four-dimension score, issues, and questions; this is the only model score | provider tokens |
| 3. Deep review | on request | issues, questions, assumptions, and context gaps; never a score | provider tokens |
| 4. Improved prompt | after a deep review with a question | a separate rewrite that leaves unknown details as `[placeholders]` | provider tokens |
| 5. Send | button / Cmd+Enter | Claude Code starts in a terminal with the prompt, or the prompt is copied | agent tokens |

Tiers 2 to 4 run through `claude -p` with the user's own Claude login: no API key, no tools, no project settings. The provider layer is ready for a Codex adapter.

## Score

Two scores have different jobs.

- The **rule pre-check** is free and immediate. It scores Target, Action, Scope, and Done when, 25 points each. A score below 65, or a secret, unfilled placeholder, or risky work, marks the prompt "should clarify": the hook blocks it, and Send asks for confirmation.
- The **quick review score** is model-scored and asynchronous. It returns a `ScoreReport` with the four dimensions, a 0-100 total, and a level: `clear` at 80 or more, `needs-work` at 55 or more, `vague` below 55. It records the provider, model, thinking effort, rubric version, and prompt hash. This is the only model score.
- A **deep review never scores**. It returns issues, questions, assumptions, and context gaps. The improved prompt is a separate action, enabled only when the deep review asked at least one question.

Quick and deep reviews keep at most 20 issues and 20 questions. A question has at most 3 options.

Rule ideas borrowed (MIT) from [akg268/prompt-preflight](https://github.com/akg268/prompt-preflight) (gate on ambiguity, question lists, `[preflight:skip]`, calibration corpus) and [preflight-dev/preflight](https://github.com/preflight-dev/preflight) (four-part score, vague verbs and pronouns, candidate files in questions).

## Layout

```
core/       control plane, plain TypeScript, no VS Code dependency
  src/analyze.ts: rule checks and the rule pre-check score
  src/schema.ts: review schemas, rubric, score parser
  src/model.ts: provider profiles and the provider factory
  src/claudeCli.ts: Claude Code CLI adapter
  src/context.ts: bounded context assembler and manifest
  src/promptFiles.ts: explicit @ file references
  src/review.ts: review prompt builders
  src/repository.ts: JSONL event repository
  src/errors.ts: feedback error taxonomy
  test/corpus.jsonl: rule cases
  test/review-corpus.jsonl: review cases
extension/  VS Code client: panel, workspace and language tools, sessions, send, study log
  src/panel.ts: webview panel and review flow
  src/sessionSlice.ts: bounded Claude and Codex session reader
  src/sessionLocator.ts: session selection
  src/codeTools.ts: agent tools over LSP types
  src/vscodeCodeTools.ts: VS Code LSP adapter and bundled rg
  src/privacy.ts: consent and redaction
  src/repository.ts: storage composition
hook/       Claude Code UserPromptSubmit hook (rules only)
e2e/        VS Code extension-host walkthroughs
```

## Develop

```bash
npm install
npm test              # vitest: unit tests + corpus
npm run typecheck
npm run build         # extension/dist, hook/dist
npm run package       # extension/prompt-preflight-0.1.0.vsix
```

Run the extension: open this folder in VS Code, press F5 (launch config "Run Extension").
Install the build: `code --install-extension extension/prompt-preflight-0.1.0.vsix`.

Found a wrong result? Add a rule case to `core/test/corpus.jsonl` or a review case to `core/test/review-corpus.jsonl`, then make the test pass.

## Claude Code hook

Blocks vague prompts typed directly into Claude Code and shows the questions instead. Build it, then add to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node /path/to/prompt-preflight/hook/dist/hook.js" }] }
    ]
  }
}
```

Add `[preflight:skip]` to a prompt to send it as is. On any error the hook lets the prompt through.

## User study

Enable `promptPreflight.studyLog.enabled` and set `promptPreflight.studyLog.participantId`. Each send appends one line to `study-log.jsonl` (command *Prompt Preflight: Open Study Log*): prompt, first and final score, draft time, rules hit, reviews used, whether the improved prompt was used, and Preflight's own tokens and cost. The agent's tokens are in Claude Code's session transcripts (`~/.claude/projects/`), not yet merged into the log.
