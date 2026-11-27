# The Claude CLI spawns in an empty temporary working directory

Status: accepted (2026-11-27, issue #56)

The CLI tells the model its working directory even when `--system-prompt` replaces the default prompt: a path-free draft made the model reply with the full absolute workspace path, user name included (issue #56 and its first comment; reproduced against Claude CLI 2.1.327). Relative `@path` mentions also resolve against the spawn cwd.

Decision: `execClaude` spawns the CLI with `cwd` set to a fresh empty temporary directory instead of the workspace root, and removes the directory when the call settles. A `claudePath` that contains a path separator and is relative still resolves against the caller-provided cwd before the spawn, because Node resolves the executable against `opts.cwd` and that was the workspace root until this change. Bare names keep PATH lookup and absolute paths pass through.

Consequences:

- The model can learn the temporary directory, never the workspace path.
- Relative `@` mentions resolve against an empty directory and find nothing. That is defense in depth behind ADR 0001, not the primary guard.
- Review session records, if the CLI writes any for `-p` runs, land under an encoded temporary-directory project name in `~/.claude/projects`, not under the workspace project, so `SessionLocator` discovery for the workspace stays clean.
- Windows cleanup of the spawn directory is best-effort (`fs.rmSync` with retries); the live Windows checklist in `docs/windows.md` gains this check.
