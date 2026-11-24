// #16 step 1, offline: replace the options of deep-review lookup questions with real candidates from the code.
// No model calls. Reads the deep-v2 run of the #18 re-run and the repository at the same commit.
//
// Build and run:
//   npx esbuild scripts/eval-grounded-options.ts --bundle --platform=node --format=esm \
//     --outfile=/tmp/eval-grounded.mjs --alias:vscode=./scripts/vscode-stub.ts
//   node /tmp/eval-grounded.mjs [--commit d4dc55f] [--out docs/measurements/grounded-options-YYYY-MM-DD]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "../extension/src/exec";
import { draftIdentifiers, shuffled } from "./evalShared";

/** "Where is X" / "which file …": a question about where existing code is, not where it should go. */
export function isLookupQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (/^where should\b/.test(q)) return false; // a design decision, not a lookup
  if (/\b(appear|appears|shown|show|see)\b/.test(q)) return false; // where the user sees something, not where code is
  if (/\band\b/.test(q)) return false; // compound: grounded options would drop the second part
  return /\bwhere (is|are)\b|\bwhich (file|files|part of the code|function|module)\b|\bwhich \w+ file\b|\bwhere\b[^?]*\b(stored|belong)\b/.test(q);
}

const STOP = new Set(
  "which what where is are the a an should does do file files part code function functions module of in to new lines line go goes receive belong belongs stored look looks like and it that this runs run live lives".split(" "),
);

/** Search terms: identifiers first, then the remaining content words of the question. */
export function lookupTerms(question: string): string[] {
  const ids = draftIdentifiers(question);
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set([...ids, ...words])];
}

const SKIP = /^(docs\/measurements\/|node_modules\/|.*\/dist\/)/;
const stem = (p: string) => path.posix.basename(p).replace(/\.[^.]+$/, "").toLowerCase();

/**
 * Up to 3 candidate paths: files that define a term, then files whose name is the term,
 * then files whose name contains it. Only paths leave this function, never file content.
 */
export function rankCandidates(terms: string[], files: string[], definitions: Map<string, string[]>): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p) && !SKIP.test(p)) out.push(p);
  };
  for (const t of terms) for (const p of definitions.get(t) ?? []) add(p);
  // Source before tests before everything else, then shorter paths first.
  const kind = (f: string) => (/(^|\/)src\//.test(f) ? 0 : /(^|\/)test\//.test(f) ? 1 : 2);
  const usable = files.filter((f) => !SKIP.test(f)).sort((a, b) => kind(a) - kind(b) || a.length - b.length || (a < b ? -1 : 1));
  for (const t of terms) for (const f of usable) if (stem(f) === t.toLowerCase()) add(f);
  for (const t of terms) for (const f of usable) if (stem(f).includes(t.toLowerCase())) add(f);
  return out.slice(0, 3);
}

async function definitionsAt(commit: string, cwd: string, terms: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const t of terms) {
    if (!/^[A-Za-z_]\w*$/.test(t)) continue;
    // POSIX ERE: no \\s or \\b in git grep -E.
    const res = await git(cwd, ["grep", "-l", "-E", `(function|const|class|interface|type|let)[[:space:]]+${t}([^[:alnum:]_]|$)`, commit, "--", "core/src", "extension/src", "hook/src"]);
    const paths = res.ok ? res.stdout.split("\n").filter(Boolean).map((l) => l.replace(`${commit}:`, "")) : [];
    if (paths.length) map.set(t, paths);
  }
  return map;
}

const csv = (v: string) => `"${v.replace(/"/g, '""')}"`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const commit = args.includes("--commit") ? args[args.indexOf("--commit") + 1] : "d4dc55f";
  const date = new Date().toISOString().slice(0, 10);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : `docs/measurements/grounded-options-${date}`;
  const source = "docs/measurements/code-access-2026-11-24-deep-v2/runs.json";

  const ls = await git(cwd, ["ls-tree", "-r", "--name-only", commit]);
  if (!ls.ok) throw new Error(`git ls-tree failed: ${ls.stderr}`);
  const files = ls.stdout.split("\n").filter(Boolean);
  const data = JSON.parse(await readFile(source, "utf8")) as {
    drafts: Array<{ id: string; text: string }>;
    runs: Array<{ runId: string; draftId: string; tier: string; model: string; review: { questions: Array<{ question: string; why: string; options: string[] }> } }>;
  };

  const pairs: Array<{ runId: string; draftId: string; tier: string; model: string; question: string; terms: string[]; original: string[]; grounded: string[] }> = [];
  for (const run of data.runs) {
    for (const q of run.review.questions) {
      if (!isLookupQuestion(q.question)) continue;
      const terms = lookupTerms(q.question);
      const grounded = rankCandidates(terms, files, await definitionsAt(commit, cwd, terms));
      pairs.push({ runId: run.runId, draftId: run.draftId, tier: run.tier, model: run.model, question: q.question, terms, original: q.options, grounded });
    }
  }

  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "pairs.json"), JSON.stringify({ date, commit, source, pairs }, null, 2) + "\n");

  // Blind paired sheet: which side is grounded is random per row and stored only in the key.
  const order = shuffled(pairs.map((_, i) => i), 16);
  const rows = order.map((i, n) => {
    const p = pairs[i];
    const groundedFirst = (n * 7 + i) % 2 === 0;
    const draft = data.drafts.find((d) => d.id === p.draftId)!.text;
    const a = (groundedFirst ? p.grounded : p.original).join(" | ") || "(no options)";
    const b = (groundedFirst ? p.original : p.grounded).join(" | ") || "(no options)";
    return { qid: `g${String(n + 1).padStart(2, "0")}`, draft, question: p.question, a, b, groundedFirst, pair: i };
  });
  const header = "qid,draft,question,options_1,options_2,better(1/2/same),right_in_1(y/n),right_in_2(y/n)";
  await writeFile(path.join(out, "compare-sheet.csv"), [header, ...rows.map((r) => [r.qid, r.draft, r.question, r.a, r.b].map(csv).join(",") + ",,,")].join("\n") + "\n");
  await writeFile(path.join(out, "compare-key.json"), JSON.stringify(rows.map((r) => ({ qid: r.qid, pair: r.pair, groundedIs: r.groundedFirst ? 1 : 2 })), null, 2) + "\n");
  console.log(`wrote ${out}: ${pairs.length} lookup questions`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
