// Live check for #13 (PR #59): real deepFeedback() with the Claude provider (haiku) over the edge-case fixtures.
// Billable: 11 `claude -p` calls (the empty draft makes none).
// Recorded runs: run-1.json used the first deep-v2 text and a "clear" draft about "handle"/"deal with";
// run-2.json used the fixed prompt and this file as it is now.
//
// Build and run from the repository root:
//   npx esbuild scripts/live-check-deep-prompt.ts --bundle --platform=node --format=esm --outfile=/tmp/live13.mjs
//   node /tmp/live13.mjs "$PWD" docs/measurements/live-check-13-2026-11-24/run-2.json

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
import cases from "../core/test/fixtures/deep-edge-cases.json";

class MemoryRepo<T> implements Repository<T> {
  events: Array<Event<T>> = [];
  async append(e: EventInput<T>) {
    const ev = { ...e, schemaVersion: SCHEMA_VERSION, seq: this.events.length + 1 } as Event<T>;
    this.events.push(ev);
    return ev;
  }
  async list() {
    return { events: this.events, skipped: 0 };
  }
  async byDraft(id: string) {
    return this.events.filter((e) => (e as { draftId?: string }).draftId === id);
  }
  async bySession(id: string) {
    return this.events.filter((e) => (e as { sessionId?: string }).sessionId === id);
  }
}

const repo = process.argv[2];
const root = { uri: pathToFileURL(repo).href, fsPath: repo };

const promptFiles = (draft: string): ContextSource => ({
  id: "prompt-files",
  priority: 80,
  collect: async () => {
    const refs = findPromptFileRefs(draft).map((r) => r.text);
    if (!refs.length) return { fragments: [], omittedReason: "empty" as const };
    const res = await resolvePromptFileRefs(refs, [root], (p) => access(p).then(() => true, () => false), realpath);
    const files = await Promise.all(res.files.map(async (f) => ({ path: f.path, folderUri: f.folderUri, content: await readFile(f.fsPath, "utf8") })));
    return buildPromptFilesResult({
      files,
      policy: { includeCode: "prompt-files", promptFiles: res.files.map((f) => f.path) },
      missing: res.missing.length,
      outside: res.outside.length,
      ambiguous: res.ambiguous.length,
      excluded: res.excluded.length,
      duplicate: res.duplicate,
      unreadable: 0,
    });
  },
});

const omittedDiff: ContextSource = { id: "git-diff", priority: 50, collect: async () => ({ fragments: [], omittedReason: "budget" as const }) };

type Expect = {
  modelCall?: boolean;
  questions?: number;
  maxIssues?: number;
  maxQuestions?: number;
  gapsMatch?: string;
  noGapsMatch?: string;
  gapsMatchCount?: { pattern: string; max: number };
};
type Case = { id: string; draft: string; instructionText?: string; expect: Expect };

const all: Case[] = [
  { id: "vague", draft: "fix the review, it is broken sometimes", expect: {} },
  {
    id: "clear",
    draft: 'In @core/src/patterns.ts add "tackle" to VAGUE_VERBS, add one line that must be flagged and one that must pass to core/test/corpus.jsonl, and npm test must pass.',
    expect: { maxIssues: 2 },
  },
  ...(cases as Case[]),
];

const out: unknown[] = [];
for (const c of all) {
  const requests: ModelRequest[] = [];
  const base = createClaudeProvider({ provider: "claude", model: "haiku", thinkingEffort: "medium" }, { claudePath: "claude" });
  const provider = {
    ...base,
    complete: (req: ModelRequest, s?: AbortSignal) => {
      requests.push(req);
      return base.complete(req, s);
    },
  };
  let n = 0;
  const instructionText = c.instructionText;
  const res = await deepFeedback(
    { draftId: c.id, draft: c.draft, folders: [root.uri] },
    {
      provider,
      model: "haiku",
      clock: { now: () => Date.now() },
      ids: () => `${c.id}-${++n}`,
      reviews: new MemoryRepo(),
      questions: new MemoryRepo(),
      redact,
      sources: (draft) => [promptFiles(draft), ...(c.id === "manifest-omission" ? [omittedDiff] : [])],
      ...(instructionText ? { instructions: { load: async () => ({ text: instructionText, files: [] }) } } : {}),
    },
  );

  const checks: Record<string, boolean> = {};
  if (res.ok) {
    const r = res.review;
    const e = c.expect;
    const gaps = r.contextGaps.join("\n");
    if (e.modelCall === false) checks.noModelCall = requests.length === 0;
    if (e.questions !== undefined) checks.questions = r.questions.length === e.questions;
    if (e.maxIssues !== undefined) checks.maxIssues = r.issues.length <= e.maxIssues;
    if (e.maxQuestions !== undefined) checks.maxQuestions = r.questions.length <= e.maxQuestions;
    if (e.gapsMatch) checks.gapsMatch = new RegExp(e.gapsMatch, "i").test(gaps);
    if (e.noGapsMatch) checks.noGapsMatch = !new RegExp(e.noGapsMatch, "i").test(gaps);
    if (e.gapsMatchCount) {
      const re = new RegExp(e.gapsMatchCount.pattern, "i");
      checks.gapsMatchCount = r.contextGaps.filter((g) => re.test(g)).length <= e.gapsMatchCount.max;
    }
    checks.limits = r.issues.length <= 3 && r.questions.length <= 3 && r.assumptions.length <= 5;
    checks.noRawAt = requests.every((q) => !/@(?!​)/.test(q.user));
  }
  out.push({ id: c.id, draft: c.draft, ok: res.ok, checks, res });
  const failed = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const status = res.ok ? `ok ${res.review.latency} ms, cost ${res.review.usage.costUsd.toFixed(4)}` : `error ${res.error.code}`;
  console.log(c.id.padEnd(26), status, failed.length ? `FAILED: ${failed.join(",")}` : "checks pass");
}
await writeFile(process.argv[3], JSON.stringify(out, null, 2));
