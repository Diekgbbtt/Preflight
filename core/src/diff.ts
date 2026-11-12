import type { Range } from "./types";

// Words (letters, digits, apostrophes) or single punctuation marks; whitespace is ignored.
const TOKEN = /[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;

/**
 * Parts of `after` that are not in `before`, compared word by word.
 * Used to show the text the user added (e.g. merged answers) in their own colour.
 */
export function addedRanges(before: string, after: string): Range[] {
  const a = [...before.matchAll(TOKEN)].map((m) => m[0]);
  const b = [...after.matchAll(TOKEN)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  // shortcut: O(n·m) table; fine for prompts, skip diffing if one ever gets huge
  if (a.length * b.length > 4_000_000) return [];

  // Longest common subsequence, filled from the end so we can walk forwards.
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j].text ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  const out: Range[] = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && a[i] === b[j].text) {
      i++;
      continue;
    }
    if (i < a.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      i++; // drop a word from `before`, then look at this word again
      j--;
      continue;
    }
    const last = out[out.length - 1];
    // join with the previous added word when only whitespace sits between them
    if (last && !after.slice(last.end, b[j].start).trim()) last.end = b[j].end;
    else out.push({ start: b[j].start, end: b[j].end });
  }
  return out;
}
