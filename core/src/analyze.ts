import * as P from "./patterns";
import type { Analysis, Dimensions, Finding, Level, Range, WorkspaceContext } from "./types";

interface Match extends Range {
  text: string;
}

function findAll(text: string, re: RegExp): Match[] {
  const out: Match[] = [];
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  global.lastIndex = 0;
  for (const m of text.matchAll(global)) {
    const value = m[1] ?? m[0];
    const start = m.index! + m[0].indexOf(value);
    out.push({ text: value, start, end: start + value.length });
  }
  return out;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** File and folder references, without framework names like "Node.js". */
export function findPathRefs(text: string): Match[] {
  const files = findAll(text, P.FILE_REF).filter((m) => !P.NOT_FILES.has(m.text.toLowerCase()));
  const dirs = findAll(text, P.DIR_REF).filter((d) => !files.some((f) => overlaps(f, d)));
  return [...files, ...dirs];
}

function findIdentifiers(text: string): Match[] {
  return P.IDENTIFIERS.flatMap((re) => findAll(text, re)).filter((m) => !P.NOT_IDENTIFIERS.has(m.text));
}

/**
 * Rule-based check of a coding-agent prompt. Pure and fast enough to run on every keystroke.
 */
export function analyze(prompt: string, ctx: WorkspaceContext = {}): Analysis {
  const text = prompt;
  const findings: Finding[] = [];
  const skipped = P.SKIP_MARKER.test(text);

  // Privacy runs first and is never skipped.
  for (const re of P.SECRETS) {
    for (const m of findAll(text, re)) {
      findings.push({
        rule: "secret",
        category: "privacy",
        severity: "error",
        message: "This looks like a secret or password. Remove it before sending.",
        range: m,
      });
    }
  }
  const hasSecret = findings.length > 0;

  if (!text.trim()) {
    return result("vague", { target: 0, action: 0, scope: 0, done: 0 }, [], [], false, skipped);
  }

  if (P.TRIVIAL.test(text)) {
    return result("trivial", { target: 25, action: 25, scope: 25, done: 25 }, findings, [], hasSecret, skipped);
  }

  const isQuestion = P.QUESTION.test(text);
  const paths = findPathRefs(text);
  const identifiers = findIdentifiers(text);
  // Paths that don't exist in the project don't count as a concrete target.
  const missing = ctx.fileExists ? paths.filter((p) => !ctx.fileExists!(p.text)) : [];
  const concreteTarget = paths.length > missing.length || identifiers.length > 0;
  const componentTarget = P.COMPONENT_WORDS.test(text) || missing.length > 0;

  for (const p of missing) {
    findings.push({
      rule: "missing-file",
      category: "target",
      severity: "warning",
      message: `"${p.text}" was not found in this workspace. Check the name or path.`,
      range: p,
    });
  }

  // --- target: where should the change happen?
  const target = concreteTarget ? 25 : componentTarget ? 15 : 5;

  // --- action: what should change?
  const strong = findAll(text, P.STRONG_VERBS);
  const vague = findAll(text, P.VAGUE_VERBS);
  const changeTo = P.CHANGE_TO.test(text);
  const doneStrong = P.DONE_STRONG.test(text);
  // "fix" alone is concrete only when we know what to fix.
  const strongNonFix = strong.filter((m) => m.text.toLowerCase() !== "fix" && !vague.some((v) => overlaps(v, m)));
  const fixIsConcrete =
    strong.some((m) => m.text.toLowerCase() === "fix" && !vague.some((v) => overlaps(v, m))) &&
    (target === 25 || doneStrong);
  let action: number;
  if (strongNonFix.length > 0 || changeTo || fixIsConcrete) action = 25;
  else if (isQuestion) action = 20;
  else if (vague.length > 0 || strong.length > 0) action = 10;
  else action = 5;

  const weakFix = action < 25 ? strong.filter((m) => m.text.toLowerCase() === "fix") : [];
  for (const v of [...vague, ...weakFix.filter((f) => !vague.some((v) => overlaps(v, f)))]) {
    findings.push({
      rule: "vague-verb",
      category: "action",
      // with a concrete target and action, a vague verb is only a hint
      severity: target === 25 && action === 25 ? "info" : "warning",
      message: `"${v.text}" can mean many things. Say what exactly should change.`,
      range: v,
    });
  }

  // --- scope: how much, and one task at a time?
  const broad = findAll(text, P.BROAD);
  const bounded = P.BOUNDED.test(text);
  let scope: number;
  if (bounded) scope = 25;
  else if (broad.length > 0 && target < 25) scope = 10;
  else scope = target === 25 ? 25 : target === 15 ? 20 : 15;

  if (broad.length > 0 && target < 25) {
    for (const b of broad.slice(0, 2)) {
      findings.push({
        rule: "broad-scope",
        category: "scope",
        severity: "warning",
        message: `"${b.text}" is very broad. Narrow it to one area, or list the places that should change.`,
        range: b,
      });
    }
  }

  const clauseVerbs = [...strong, ...vague].filter((m) => {
    const before = text.slice(Math.max(0, m.start - 12), m.start);
    return m.start === 0 || /(?:^|[.;:!?\n]|\band\b|\bthen\b|\balso\b|\bplease\b|[-*•]|\d[.)])\s*$/i.test(before);
  });
  const multiTask = new Set(clauseVerbs.map((m) => m.start)).size >= 3;
  if (multiTask) {
    scope = Math.min(scope, 15);
    findings.push({
      rule: "multi-task",
      category: "scope",
      severity: "info",
      message: "Several tasks in one prompt. Agents do better with one task at a time, or a numbered plan.",
    });
  }

  // --- done: how will we know it worked?
  let done: number;
  if (doneStrong || changeTo) done = 25;
  else if (isQuestion) done = 20;
  else if (P.DONE_PARTIAL.test(text)) done = 15;
  else done = 5;

  // --- clarity
  const words = wordCount(text);
  for (const p of findAll(text, P.PRONOUNS)) {
    const early = wordCount(text.slice(0, p.start)) < 5;
    // "fix it", "make this": the object of a vague verb is always worth asking about
    const afterVague = vague.some((v) => v.end <= p.start && p.start - v.end <= 1);
    if (afterVague || (target < 25 && (words < 15 || early))) {
      findings.push({
        rule: "unclear-reference",
        category: "clarity",
        severity: "warning",
        message: `What does "${p.text}" refer to? The agent can't see what you are looking at.`,
        range: p,
      });
    }
  }

  for (const s of findAll(text, P.SUBJECTIVE)) {
    const after = text.slice(s.end, s.end + 30);
    if (/\d/.test(after)) continue; // "faster than 200 ms" is measurable
    findings.push({
      rule: "subjective",
      category: "clarity",
      severity: "info",
      message: `"${s.text}" is subjective. How would you measure or recognise it?`,
      range: s,
    });
  }

  for (const ph of findAll(text, P.PLACEHOLDER)) {
    if (/^preflight:skip$/i.test(ph.text)) continue;
    const range = { start: ph.start - 1, end: ph.end + 1 };
    findings.push({
      rule: "placeholder",
      category: "clarity",
      severity: "warning",
      message: "Fill in this placeholder before sending.",
      range,
    });
  }

  if (words < 4 && !isQuestion) {
    findings.push({
      rule: "too-short",
      category: "clarity",
      severity: "warning",
      message: "Very short prompt. The agent will have to guess most of the details.",
    });
  }

  // --- risk
  const risks = findAll(text, P.RISK);
  for (const r of risks.slice(0, 2)) {
    findings.push({
      rule: "risky",
      category: "risk",
      severity: "warning",
      message: `"${r.text}" is risky work. Ask for a plan first and say what must not change.`,
      range: r,
    });
  }

  // --- summary findings for missing dimensions (no range)
  if (target === 5) {
    findings.push({ rule: "no-target", category: "target", severity: "warning", message: "No file, function or part of the app is named." });
  } else if (target === 15) {
    findings.push({ rule: "weak-target", category: "target", severity: "info", message: "Name the exact file, function or component if you know it." });
  }
  if (action === 5) {
    findings.push({ rule: "no-action", category: "action", severity: "warning", message: "No clear action. Start with a verb like add, remove, rename or explain." });
  }
  if (done === 5) {
    findings.push({ rule: "no-done", category: "done", severity: "warning", message: "No success criteria. How will you know the task is done?" });
  } else if (done === 15) {
    findings.push({ rule: "no-expected", category: "done", severity: "info", message: "You describe what's wrong, but not what should happen instead." });
  }

  const dimensions: Dimensions = { target, action, scope, done };
  const score = target + action + scope + done;
  const level: Level = score >= 80 ? "clear" : score >= 55 ? "needs-work" : "vague";
  const hasUnfilled = findings.some((f) => f.rule === "placeholder");
  const shouldClarify =
    hasSecret ||
    (!skipped &&
      (score < 65 ||
        hasUnfilled ||
        (risks.length > 0 && score < 80) ||
        // neither where nor when-done: the agent has to guess both
        (target < 25 && done === 5)));

  const questions = level === "clear" && !shouldClarify
    ? []
    : buildQuestions(dimensions, { broad: broad.length > 0, multiTask, risky: risks.length > 0, findings, ctx });

  return result(level, dimensions, findings, questions, shouldClarify, skipped);
}

function result(
  level: Level,
  dimensions: Dimensions,
  findings: Finding[],
  questions: string[],
  shouldClarify: boolean,
  skipped: boolean,
): Analysis {
  const score = dimensions.target + dimensions.action + dimensions.scope + dimensions.done;
  findings.sort((a, b) => (a.range?.start ?? Infinity) - (b.range?.start ?? Infinity));
  return { level, score, dimensions, findings, questions, shouldClarify, skipped };
}

function buildQuestions(
  d: Dimensions,
  o: { broad: boolean; multiTask: boolean; risky: boolean; findings: Finding[]; ctx: WorkspaceContext },
): string[] {
  const q: string[] = [];
  if (o.findings.some((f) => f.rule === "unclear-reference")) {
    q.push("What exactly do you mean by \"it\" or \"this\"? Name the file, function or behaviour.");
  } else if (d.target < 25) {
    const recent = (o.ctx.recentFiles ?? []).slice(0, 3);
    q.push(
      recent.length > 0
        ? `Which file or function should change? Recently changed: ${recent.map((f) => "`" + f + "`").join(", ")}.`
        : "Which file, function or component should change?",
    );
  }
  if (d.action <= 10) q.push("What exactly should change? For example: add …, remove …, rename … to ….");
  if (d.done === 15) q.push("What should happen instead of the current behaviour?");
  else if (d.done < 15) q.push("How will you know it's done? Describe the expected result or a test that should pass.");
  if (o.multiTask) q.push("Which task comes first? Sending one task at a time works better.");
  else if (o.broad && d.scope < 25) q.push("Can you narrow this to one area, or list the places that should change?");
  if (o.risky) q.push("Should the agent show a plan before changing anything? What must not change?");
  return q.slice(0, 3);
}
