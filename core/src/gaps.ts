import type { Analysis, Category, Finding, Gap, GapPriority, GapSource } from "./types";

/** A gap as a model reports it: free text, a quote instead of a span, values not yet checked. */
export interface ModelGap {
  category?: string;
  priority?: string;
  quote?: string;
  question: string;
  reason: string;
  suggestion?: string;
}

const CATEGORIES = new Set<Category>(["target", "action", "scope", "done", "clarity", "risk", "privacy"]);

/** Rule findings that say a whole dimension is missing or weak; they become one gap per dimension. */
const MISSING: Record<string, Category> = {
  "no-target": "target",
  "weak-target": "target",
  "no-action": "action",
  "no-done": "done",
  "no-expected": "done",
};

/** Above this share of the prompt, a quote is not a useful underline. */
const MAX_SPAN_SHARE = 0.6;

function rulePriority(f: Finding): GapPriority {
  if (f.category === "privacy") return "blocking";
  return f.severity === "info" ? "advisory" : "important";
}

/** Rule output as gaps. Ids are stable across edits that don't touch the flagged words. */
export function ruleGaps(prompt: string, a: Analysis): Gap[] {
  const seen = new Map<string, number>();
  return a.findings.map((f): Gap => {
    const span = f.range ? { ...f.range, text: prompt.slice(f.range.start, f.range.end) } : undefined;
    let id: string;
    if (MISSING[f.rule] && !span) {
      id = `rules:missing-${MISSING[f.rule]}`;
    } else {
      const base = `rules:${f.rule}:${span ? span.text : "none"}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      id = `${base}:${n}`;
    }
    return {
      id,
      category: f.category,
      priority: rulePriority(f),
      span,
      question: f.short || f.message,
      reason: f.message,
      source: "rules",
      status: "open",
    };
  });
}

/**
 * Where a model's quote sits in the prompt: an exact match, else a case- and whitespace-insensitive one.
 * No span when the quote is missing, ambiguous (several matches) or covers most of the prompt.
 */
export function resolveQuote(prompt: string, quote: string | undefined): Gap["span"] | undefined {
  const q = quote?.trim();
  if (!q) return undefined;
  const exact: number[] = [];
  for (let at = prompt.indexOf(q); at >= 0; at = prompt.indexOf(q, at + 1)) exact.push(at);
  let match: { start: number; end: number } | undefined;
  if (exact.length === 1) match = { start: exact[0], end: exact[0] + q.length };
  else if (exact.length === 0) {
    const words = q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const fuzzy = [...prompt.matchAll(new RegExp(words.join("\\s+"), "gi"))];
    if (fuzzy.length === 1) match = { start: fuzzy[0].index!, end: fuzzy[0].index! + fuzzy[0][0].length };
  }
  if (!match || match.end - match.start > prompt.length * MAX_SPAN_SHARE) return undefined;
  return { ...match, text: prompt.slice(match.start, match.end) };
}

/** Model output as gaps. Only privacy may be blocking; unknown values fall back to clarity / advisory. */
export function modelGaps(prompt: string, items: ModelGap[], source: Exclude<GapSource, "rules">, revision: number): Gap[] {
  return items.map((m, i): Gap => {
    const category = CATEGORIES.has(m.category as Category) ? (m.category as Category) : "clarity";
    let priority: GapPriority = m.priority === "important" || m.priority === "advisory" ? m.priority : "advisory";
    if (m.priority === "blocking") priority = category === "privacy" ? "blocking" : "important";
    return {
      id: `${source}:${revision}:${i}`,
      category,
      priority,
      span: resolveQuote(prompt, m.quote),
      question: m.question,
      reason: m.reason,
      suggestion: m.suggestion || undefined,
      source,
      status: "open",
    };
  });
}

/** One list without duplicates: first gap per id wins, and a rules gap beats a model gap on the same category and words. */
export function combineGaps(rules: Gap[], ...models: Gap[][]): Gap[] {
  const out: Gap[] = [];
  const ids = new Set<string>();
  const ruleSpans = new Set(rules.filter((g) => g.span).map((g) => `${g.category}\u0000${g.span!.text}`));
  for (const g of [...rules, ...models.flat()]) {
    if (ids.has(g.id)) continue;
    if (g.source !== "rules" && g.span && ruleSpans.has(`${g.category}\u0000${g.span.text}`)) continue;
    ids.add(g.id);
    out.push(g);
  }
  return out;
}
