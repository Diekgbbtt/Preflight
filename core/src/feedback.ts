import type { RuleReport } from "./types";
import type { QuickReview } from "./schema";
import type { ReviewIssue } from "./review";

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const topics = (s: string): string[] => {
  const t = key(s);
  return [
    /\b(refer|reference|pronoun|mean by|what does|which (file|function|component))\b/.test(t) ? "target" : "",
    /\b(success|expected|done|test.*pass)\b/.test(t) ? "done" : "",
    /\b(scope|narrow|broad)\b/.test(t) ? "scope" : "",
  ].filter(Boolean);
};

/** Presentation deduplication: retain all original ranges for highlighting, display a gap once. */
export function presentFeedback(rules: RuleReport, quick?: QuickReview): { findings: RuleReport["findings"]; issues: ReviewIssue[]; questions: string[] } {
  const seen = new Set<string>();
  const covered = new Set<string>();
  const keep = (text: string) => {
    const k = key(text), ts = topics(text);
    if (!k || seen.has(k) || ts.some(t => covered.has(t))) return false;
    seen.add(k); ts.forEach(t => covered.add(t)); return true;
  };
  // Concrete rule notes precede model advice. Generic questions fill remaining gaps.
  const findings = rules.findings.filter(f => keep(f.message));
  const issues = (quick?.issues ?? []).filter(i => keep(`${i.problem} ${i.suggestion}`));
  const questions = [...(quick?.questions ?? []), ...rules.questions].filter(keep);
  return { findings, issues, questions };
}
