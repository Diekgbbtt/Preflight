# Windows path coverage

**Status:** unit-tested on macOS; the live Windows run is not measured yet.
**Scope:** folder URIs, Claude project encoding, workspace-relative paths, and `@` references.

## Rules

- `canonicalFolderUri` lowercases a Windows drive letter.
- `file:///C:/Users/Alice/Proj/` becomes `file:///c:/Users/Alice/Proj`.
- `file:///C:/` stays `file:///c:/`.
- `file://localhost/C:/Users/Alice/Proj` becomes `file:///c:/Users/Alice/Proj`.
- `file://server/share/proj/` becomes `file://server/share/proj`.
- A malformed file URI is returned unchanged.
- `encodeClaudeProjectPath` replaces every character outside `[A-Za-z0-9_-]` with `-`.
- `/Users/Alice/Proj` becomes `-Users-Alice-Proj`.
- `C:\Users\Alice\Proj` becomes `C--Users-Alice-Proj`.
- `C:\Users\Alice\My Proj` becomes `C--Users-Alice-My-Proj`.
- `relativeToWorkspace` uses `path.win32` on Windows.
- `C:\Users\alice\proj\src\app.ts` against `C:\Users\alice\proj` becomes `src/app.ts`.
- A path on another drive, a `..` path, and an absolute path return `null`.
- `@` references normalize backslashes to `/`.
- An absolute `@` reference, a drive-letter reference, and a `..` reference are rejected by the resolver.

## Unit tests

- `extension/test/sessionLocator.test.ts` covers `canonicalFolderUri` and `encodeClaudeProjectPath`.
- `extension/test/sessionSlice.test.ts` covers `relativeToWorkspace` with `path.win32`.
- `extension/test/promptFiles.test.ts` covers the resolver with `path.win32`.

## Live Windows steps

These steps are not run on this machine.
Run them in a Windows checkout and record the result in the table.

1. Run `npm ci`.
2. Run `npm run typecheck`.
3. Run `npm test`.
4. Run `npm run build`.
5. Launch the extension in VS Code.
6. Open a sample project at `C:\work\sample`.
7. Type a prompt with `@src\app.ts`.
8. Confirm the context manifest includes `src/app.ts` under `prompt-files`.
9. Start a Claude Code session in the sample project.
10. Confirm discovery finds `%USERPROFILE%\.claude\projects\C--work-sample`.
11. Start a Codex session in the sample project.
12. Confirm discovery finds the rollout under `%USERPROFILE%\.codex\sessions`.
13. Send a prompt and confirm the send record folder URI is `file:///c:/work/sample`.

| Check | Result | Notes |
|---|---|---|
| Typecheck | not run | |
| Unit tests | not run | |
| Build | not run | |
| `@` reference context | not run | |
| Claude discovery | not run | |
| Codex discovery | not run | |
| Send record URI | not run | |
