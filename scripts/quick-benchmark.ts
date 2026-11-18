/** Alternating old/new end-to-end CLI samples. No draft or model reply is printed. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { analyzeRules, buildReviewRequest, checkHealth, claudeCliRunner, createProvider, QUICK_REPLY_SCHEMA, RUBRIC_TEXT, parseQuickReview, type Config } from "../core/src";
const config: Config = { provider: "claude", model: "haiku", quickModel: "haiku", deepModel: "sonnet", thinkingEffort: "medium", claudePath: process.env.PREFLIGHT_BENCH_CLI ?? "claude" };
const profile = { provider: "claude" as const, model: "haiku", thinkingEffort: "medium" };
const prompt = "In src/greet.ts rename greet to welcome, change its callers only, and ensure npm test passes.";
const baselineRef = process.env.PREFLIGHT_BENCH_BASE ?? "776dd9ad1571687af9cd55564b588e277c4c2b3c";
const baselineSource = execFileSync("git", ["show", `${baselineRef}:core/src/review.ts`], { encoding: "utf8" });
const template = baselineSource.match(/(?:export )?const QUICK_SYSTEM = `([\s\S]*?)`;/)?.[1];
if (!template) throw new Error("Baseline QUICK_SYSTEM not found");
const baseline = template.replace("${RUBRIC_TEXT}", RUBRIC_TEXT).replace("${QUICK_REPLY_SCHEMA}", QUICK_REPLY_SCHEMA);
const samples: Array<{ variant: string; latencyMs: number; ok: boolean; scoreAvailable: boolean; inputTokens?: number; outputTokens?: number }> = [];
for (let round = 0; round < 3; round++) {
  for (const variant of ["before", "after"]) {
    const start = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      if (variant === "before") {
        const health = await checkHealth(createProvider(profile, config), profile, config.claudePath);
        if (!health.ok) throw new Error(health.error.code);
      }
      const request = buildReviewRequest(prompt, "quick", profile.model, { analysis: analyzeRules(prompt) });
      if (variant === "before") request.system = baseline;
      const response = await claudeCliRunner(config.claudePath, process.cwd(), profile.thinkingEffort)(request, ctrl.signal);
      const quick = parseQuickReview(response.text, prompt, { ...profile, scoredAt: new Date().toISOString() });
      samples.push({ variant, latencyMs: Math.round(performance.now() - start), ok: true, scoreAvailable: !!quick.score, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
    } catch {
      samples.push({ variant, latencyMs: Math.round(performance.now() - start), ok: false, scoreAvailable: false });
    } finally { clearTimeout(timer); }
    console.log(JSON.stringify(samples.at(-1)));
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? null;
const result = { baselineRef, measuredAt: new Date().toISOString(), model: profile.model, thinkingEffort: profile.thinkingEffort, samples,
  beforeMedianMs: median(samples.filter(s => s.variant === "before" && s.ok).map(s => s.latencyMs)),
  afterMedianMs: median(samples.filter(s => s.variant === "after" && s.ok).map(s => s.latencyMs)) };
await writeFile(process.env.PREFLIGHT_BENCH_OUTPUT ?? "/tmp/preflight-quick-benchmark.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ beforeMedianMs: result.beforeMedianMs, afterMedianMs: result.afterMedianMs }));
