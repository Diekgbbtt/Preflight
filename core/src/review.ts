import type { Analysis, Range } from "./types";

export type ReviewMode = "quick" | "deep";

export interface ModelRequest {
  system: string;
  user: string;
  model: string;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Anything that can answer a prompt: the claude CLI, an API client, a test stub. */
export type ModelRunner = (req: ModelRequest, signal?: AbortSignal) => Promise<ModelResponse>;

export interface ReviewIssue {
  /** Exact words from the prompt the issue is about, if any. */
  quote?: string;
  range?: Range;
  /** Short question to the user for the inline pill, e.g. "Which page?". */
  question?: string;
  problem: string;
  suggestion: string;
}

export interface Review {
  mode: ReviewMode;
  verdict: "ready" | "needs-work";
  issues: ReviewIssue[];
  questions: string[];
  /** Deep mode only. Unknown details are left as [placeholders]. */
  improvedPrompt?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

const RUBRIC = `A good prompt for a coding agent states:
1. Target: the files, functions or parts of the app involved.
2. Action: the concrete change, not "improve" or "fix it".
3. Scope: how much should change, one task at a time, what must stay the same.
4. Done: expected behaviour or a test that shows the task is finished.
5. Context the agent cannot guess: error messages, constraints, libraries to use or avoid.`;

const QUICK_SYSTEM = `You review prompts that a user is about to send to an AI coding agent. You do not do the task.
${RUBRIC}

Find what is missing or ambiguous that would make the agent guess. Only flag real gaps; a short prompt can be complete.
Reply with JSON only, no prose, in this shape:
{"verdict":"ready"|"needs-work","issues":[{"quote":"exact words from the prompt or empty","question":"what to ask the user, max 6 words, e.g. Which page?","problem":"max 15 words","suggestion":"max 20 words"}],"questions":[]}
At most 3 issues.`;

const DEEP_SYSTEM = `You help a user finish a prompt for an AI coding agent before they send it. You do not do the task.
${RUBRIC}

Ask the questions whose answers would let the agent do the task in one go, without guessing. Be specific to this prompt and project: name the files, behaviours or choices you are asking about. Do not ask about anything the prompt already answers. Each question is one sentence of at most 15 words that the user can answer in a few words. Ask nothing if the prompt is complete.
Reply with JSON only, no prose, in this shape:
{"verdict":"ready"|"needs-work","issues":[{"quote":"exact words from the prompt or empty","problem":"what is missing and why it matters","suggestion":"how to fix it"}],"questions":["up to 4 questions to the user, most important first"]}`;

export interface ReviewContext {
  analysis?: Analysis;
  /** Short project facts, e.g. file names or recently changed files. */
  projectNotes?: string;
}

export function buildReviewRequest(prompt: string, mode: ReviewMode, model: string, ctx: ReviewContext = {}): ModelRequest {
  const parts = [`<prompt>\n${prompt}\n</prompt>`];
  if (ctx.analysis) {
    const rules = ctx.analysis.findings.map((f) => `- ${f.message}`).join("\n");
    parts.push(
      mode === "quick"
        ? `The user already sees these rule-based notes. Do NOT repeat them; report only other problems, or return "issues": [] if there are none:\n${rules || "- nothing"}`
        : `Rule-based checks already found:\n${rules || "- nothing"}`,
    );
  }
  if (ctx.projectNotes) parts.push(`Project context:\n${ctx.projectNotes}`);
  return { system: mode === "quick" ? QUICK_SYSTEM : DEEP_SYSTEM, user: parts.join("\n\n"), model };
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and stray text). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model reply");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseReview(prompt: string, mode: ReviewMode, res: ModelResponse): Review {
  const raw = extractJson(res.text) as Record<string, unknown>;
  const issues: ReviewIssue[] = (Array.isArray(raw.issues) ? raw.issues : [])
    .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
    .map((i) => {
      const quote = typeof i.quote === "string" && i.quote.trim() ? i.quote.trim() : undefined;
      const at = quote ? prompt.indexOf(quote) : -1;
      return {
        quote,
        range: at >= 0 ? { start: at, end: at + quote!.length } : undefined,
        question: typeof i.question === "string" && i.question.trim() ? i.question.trim() : undefined,
        problem: String(i.problem ?? ""),
        suggestion: String(i.suggestion ?? ""),
      };
    })
    .filter((i) => i.problem);
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(String).slice(0, mode === "deep" ? 4 : 3);
  return {
    mode,
    verdict: raw.verdict === "ready" ? "ready" : "needs-work",
    issues,
    questions,
    improvedPrompt: typeof raw.improvedPrompt === "string" ? raw.improvedPrompt : undefined,
    usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
  };
}

export interface Answer {
  question: string;
  answer: string;
}

const MERGE_SYSTEM = `You edit a prompt that a user is about to send to an AI coding agent. You do not do the task.
The user answered clarifying questions about the prompt. Rewrite the prompt so it includes their answers.
Keep the user's words and voice; change only the parts the answers make precise. Add no facts beyond the prompt and the answers. Keep it about as short as the original.
Reply with the rewritten prompt only: no quotes, no labels, no commentary.`;

export function buildMergeRequest(prompt: string, answers: Answer[], model: string): ModelRequest {
  const qa = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
  return { system: MERGE_SYSTEM, user: `<prompt>\n${prompt}\n</prompt>\n\n<answers>\n${qa}\n</answers>`, model };
}

/** Rewrite the prompt with the user's answers. Only called on the user's request. */
export async function mergeAnswers(
  prompt: string,
  answers: Answer[],
  run: ModelRunner,
  model: string,
  signal?: AbortSignal,
): Promise<{ text: string; usage: Review["usage"] }> {
  const res = await run(buildMergeRequest(prompt, answers, model), signal);
  const fenced = res.text.match(/```[a-z]*\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : res.text).trim().replace(/^<prompt>\s*|\s*<\/prompt>$/g, "");
  if (!text) throw new Error("The rewrite came back empty. Try again.");
  return { text, usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd } };
}

export async function review(
  prompt: string,
  mode: ReviewMode,
  run: ModelRunner,
  model: string,
  ctx: ReviewContext = {},
  signal?: AbortSignal,
): Promise<Review> {
  const res = await run(buildReviewRequest(prompt, mode, model, ctx), signal);
  return parseReview(prompt, mode, res);
}
