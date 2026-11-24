// Live check for #46 (PR #58): two real deep reviews (haiku) through deepFeedback() with the Claude provider.
// Billable: 2 `claude -p` calls on your account.
//
// Build and run from the repository root:
//   npx esbuild scripts/live-check-deep-feedback.ts --bundle --platform=node --format=esm --outfile=/tmp/live46.mjs
//   node /tmp/live46.mjs "$PWD" docs/measurements/live-check-46-2026-11-24/out.json

import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createClaudeProvider,
  deepFeedback,
  findPromptFileRefs,
  SCHEMA_VERSION,
  type ContextSource,
  type Event,
  type EventInput,
  type ModelRequest,
  type Repository,
} from "../core/src/index";
import { redact } from "../extension/src/privacy";
import { buildPromptFilesResult, resolvePromptFileRefs } from "../extension/src/promptFiles";

class MemoryRepo<T> implements Repository<T> {
  events: Array<Event<T>> = [];
  async append(e: EventInput<T>) {
    const ev = { ...e, schemaVersion: SCHEMA_VERSION, seq: this.events.length + 1 } as Event<T>;
    this.events.push(ev);
    return ev;
  }
  async list() { return { events: this.events, skipped: 0 }; }
  async byDraft(id: string) { return this.events.filter((e) => (e as { draftId?: string }).draftId === id); }
  async bySession(id: string) { return this.events.filter((e) => (e as { sessionId?: string }).sessionId === id); }
}

const repo = process.argv[2];
const promptFiles = (draft: string): ContextSource => ({
  id: "prompt-files",
  priority: 80,
  collect: async () => {
    const refs = findPromptFileRefs(draft).map((r) => r.text);
    const res = await resolvePromptFileRefs(refs, [{ uri: pathToFileURL(repo).href, fsPath: repo }], (p) => access(p).then(() => true, () => false), realpath);
    const files = await Promise.all(res.files.map(async (f) => ({ path: f.path, folderUri: f.folderUri, content: await readFile(f.fsPath, "utf8") })));
    return buildPromptFilesResult({ files, policy: { includeCode: "prompt-files", promptFiles: res.files.map((f) => f.path) }, missing: res.missing.length, outside: res.outside.length, ambiguous: res.ambiguous.length, excluded: res.excluded.length, duplicate: res.duplicate, unreadable: 0 });
  },
});

const drafts = [
  { id: "vague", text: "fix the review, it is broken sometimes" },
  { id: "file", text: "In @core/src/analyze.ts make the vague-verb rule also catch \"handle\" and \"deal with\". Add corpus lines. Also check @.env and @core/src/gate.ts." },
];

const out: unknown[] = [];
for (const d of drafts) {
  const requests: ModelRequest[] = [];
  const provider = createClaudeProvider({ provider: "claude", model: "haiku", thinkingEffort: "medium" }, { claudePath: "claude" });
  const spy = { ...provider, complete: (req: ModelRequest, s?: AbortSignal) => { requests.push(req); return provider.complete(req, s); } };
  let n = 0;
  const res = await deepFeedback({ draftId: d.id, draft: d.text, folders: [pathToFileURL(repo).href] }, {
    provider: spy, model: "haiku", clock: { now: () => Date.now() }, ids: () => `${d.id}-${++n}`,
    reviews: new MemoryRepo(), questions: new MemoryRepo(), sources: (draft) => [promptFiles(draft)], redact,
  });
  const user = requests[0]?.user ?? "";
  out.push({ draft: d.text, rawAtInUser: /@(?!​)/.test(user), envInUser: user.includes("FAKE") || user.includes(".env\n"), userChars: user.length, res });
  console.log(d.id, res.ok ? `ok ${res.review.latency} ms, in ${res.review.usage.inputTokens} tok` : `error ${res.error.code}`);
}
await writeFile(process.argv[3], JSON.stringify(out, null, 2));
