# Prompt Preflight

Prompt Preflight gives feedback on coding-agent prompts before they are sent. This is the glossary for the whole repository.

## Language

**Mention**:
An `@path` token in a draft that names a file. Preflight resolves mentions itself through the prompt-files policy; the Claude CLI has its own mention parser that must never see an unneutralized mention.
_Avoid_: file reference (the resolved file is a "prompt file")

**Neutralization**:
Inserting a zero-width space after every `@` in the stdin payload so the CLI mention parser finds no mention. It applies to the payload bytes only; the draft, the request object, and the prompt hash stay unchanged.

**Spawn directory**:
The fresh empty temporary directory the Claude CLI runs in for one model call. It replaces the workspace root as the CLI cwd, so relative mentions resolve to nothing and the model never learns the workspace path.
_Avoid_: working directory (ambiguous with the workspace)

**Live privacy check**:
The manual live check (`npm run live:privacy`) that sends probe drafts to the real Claude CLI and expects `NONE`, guarding the privacy boundary against a CLI parser change.
