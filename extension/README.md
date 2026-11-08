# Prompt Preflight

Feedback on prompts for coding agents before you send them.

Write your prompt in the **Prompt Preflight** panel (activity bar, or `Cmd/Ctrl+Alt+P`):

- **While typing:** rule checks highlight missing targets, vague verbs, unclear references, placeholders and secrets, and score the prompt (Target, Action, Scope, Done when).
- **When you pause:** a small model (Haiku) looks for gaps the rules missed.
- **On request:** *Detailed feedback* explains each issue and suggests an improved prompt, with unknown details left as `[placeholders]`.
- **Send:** starts Claude Code in a terminal with your prompt, or copies it.

Model checks run through the Claude Code CLI with your own login (`claude -p`). No API key needed.

Settings: `promptPreflight.*` (models, pause delay, send target, study log).
