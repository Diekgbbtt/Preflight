# Prompt Preflight

Preflight (working name) gives feedback on coding-agent prompts before they're sent. We don't try to improve the agent's execution itself (Codex/Claude Code are far ahead there).

Vague prompts make agents guess, loop and spend tokens. Preflight checks the prompt while the user writes it, asks for missing goals, context and success criteria, and only then hands it to Claude Code. Users write a prompt the agent can solve in one run, and learn what a complete prompt looks like.

## Documentation

- [Install, settings, workflow and troubleshooting](docs/USAGE.md)
- [Current architecture and data flow](docs/ARCHITECTURE.md)
- [Contributing and validation](CONTRIBUTING.md)
- [Prioritized improvement suggestions and linked GitHub issues](docs/IMPROVEMENTS.md)

The linked guides describe the current prototype separately from the planned architecture in [issue #28](https://github.com/Diekgbbtt/Preflight/issues/28).

## Cheap checks first

| Tier | When | What | Cost |
|---|---|---|---|
| 1. Local rules | every input; notes settle after 300 ms | Target, action, scope, completion, clarity, risk and privacy checks | free |
| 2. Enhance | explicit button click | Model review and a separate improved prompt with unknown details left as placeholders | CLI-reported usage |
| 3. Send | button / Cmd+Enter | Starts Claude Code or copies the prompt; never starts a model review | agent tokens after handoff |

Typing, pauses and Send do not call the LLM. Enhance uses `claude -p` with the user's Claude login. The old `quickReviewOnPause` setting is ignored, including existing opt-ins.


## Score

Live feedback comes from local rules. The panel shows a local status and Target/Action/Scope/Done checklist, with detailed highlights, notes and questions. These are heuristic checks, not a model quality score. There is no automatic numeric model score.

**Enhance** explicitly requests a model review and, when it identifies questions, a separate rewrite. The draft changes only when **Use this prompt** is clicked. The quick-scoring API remains available for experiments, but the panel does not schedule it automatically.

Send is advisory by default. Enable `promptPreflight.gateSending` to confirm when local warnings remain; Send never calls a model. See [the current behavior](docs/USAGE.md#write-review-and-send).


Rule ideas borrowed (MIT) from [akg268/prompt-preflight](https://github.com/akg268/prompt-preflight) (gate on ambiguity, at most three questions, `[preflight:skip]`, calibration corpus) and [preflight-dev/preflight](https://github.com/preflight-dev/preflight) (four-part score, vague verbs and pronouns, candidate files in questions).

## Layout

```
core/       rule engine + model review, plain TypeScript, no VS Code dependency
  src/patterns.ts    word lists and regexes
  src/analyze.ts     advisory rules; legacy hook analysis
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

The hook is a separate, opt-in rule-only policy. It cannot read VS Code settings, including `gateSending`. In the hook only, add `[preflight:skip]` to bypass ambiguity checks; detected secrets still require clarification. On any error the hook lets the prompt through.

## User study

Enable `promptPreflight.studyLog.enabled` and set `promptPreflight.studyLog.participantId`. Append-only `study-events-v2.jsonl` links send, quick score, review, agent usage and outcome events by draft/send/session IDs. Model observations supply first/final scores; unavailable scores stay null. The exact sent draft is stored once in `sends.jsonl`. Preflight tokens stay separate from agent input/output/cache counters, collected from the exact Claude session when its terminal closes. Unreported agent cost stays null. Clipboard sends have no automatic agent attribution.

Legacy `study-log.jsonl` sends migrate without treating their symbolic scores as model scores. Run *Prompt Preflight: Open Study Log* to open the new log. See [schema, migration and verification](docs/handoff/lane-3.md).

Historical quick-review measurements before switching to explicit-only enhancement (three paired Haiku samples, medium effort): median **8.05 s → 5.42 s**, about **33% lower**. The two-second goal remains unmet; [method and limitations](docs/handoff/lane-3.md#latency).
