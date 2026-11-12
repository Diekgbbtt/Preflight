# Prompt Preflight

Feedback on prompts for coding agents before you send them.

Write your prompt in the **Prompt Preflight** panel (activity bar, or `Cmd/Ctrl+Alt+P`):

- **While typing:** nothing moves except your text.
- **When you pause:** rule checks and a small model (Haiku) underline vague words in blue and show short questions under the prompt ("Improve what?", "Which page?"), and the strength meter fills in (Weak prompt, Getting there, Strong prompt). Click a question to answer it.
- **On request:** *Ask me* has Sonnet ask up to four detailed questions about the prompt.
- **Your answers:** choose *Add to prompt* and they are written into the prompt, shown in green. `Cmd/Ctrl+Z` undoes it.
- **Send:** the round button (or `Cmd/Ctrl+Enter`) starts Claude Code in a terminal with your prompt, or copies it. It turns orange once the prompt is strong. *Copy Prompt* is in the panel's title bar.

Model checks run through the Claude Code CLI with your own login (`claude -p`). No API key needed.

Settings: `promptPreflight.*` (models, pause delay, send target, study log).
