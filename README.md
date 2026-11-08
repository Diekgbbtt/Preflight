# Prompt Preflight

Preflight (working name) gives feedback on coding-agent prompts before they're sent. We don't try to improve the agent's execution itself (Codex/Claude Code are far ahead there).

Vague prompts make agents guess, loop and spend tokens. Preflight checks the prompt while the user writes it, asks for missing goals, context and success criteria, and only then hands it to Claude Code. Users write a prompt the agent can solve in one run, and learn what a complete prompt looks like.

## Cheap checks first

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Rules | every keystroke | `core/src/analyze.ts`: highlights, score, questions | free |
| 2. Small model | typing pauses (1.5 s) | Haiku looks for gaps the rules missed | ~$0.0004 |
| 3. Detailed feedback | on request | Sonnet explains each issue, suggests an improved prompt with `[placeholders]` | ~$0.02 |
| 4. Send | button / Cmd+Enter | Claude Code starts in a terminal with the prompt | agent tokens |

Tiers 2 and 3 run through `claude -p` with the user's own Claude login: no API key, no tools, no project settings.

## Score

Four parts, 25 points each: **Target** (file, function, component), **Action** (concrete change, not "improve"), **Scope** (bounded, one task), **Done when** (expected behaviour or test). Below 65, or with secrets, unfilled placeholders or risky work, the prompt "should clarify": Send asks for confirmation, the hook blocks.

Rule ideas borrowed (MIT) from [akg268/prompt-preflight](https://github.com/akg268/prompt-preflight) (gate on ambiguity, at most three questions, `[preflight:skip]`, calibration corpus) and [preflight-dev/preflight](https://github.com/preflight-dev/preflight) (four-part score, vague verbs and pronouns, candidate files in questions).

## Layout

```
core/       rule engine + model review, plain TypeScript, no VS Code dependency
  src/patterns.ts    word lists and regexes
  src/analyze.ts     rules, score, questions
  src/review.ts      prompts for the model tiers, JSON parsing
  src/claudeCli.ts   runs a model call via `claude -p`
  test/corpus.jsonl  reviewed prompts with expected results
extension/  VS Code extension: side panel, workspace index, send, study log
hook/       Claude Code UserPromptSubmit hook (rules only)
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

Found a wrong result? Add a line to `core/test/corpus.jsonl` and make it pass.

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
