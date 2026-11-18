import type { RuleReport } from "./types";
import { hashPrompt, RUBRIC_VERSION, type ScoreReport } from "./schema";

export interface GateSettings { gateSending: boolean; threshold: number; scoreRequired?: boolean }
export type GateDecision = { action: "send" | "confirm"; reasons: string[] };
export function isFreshScore(score: ScoreReport | null | undefined, draft: string): score is ScoreReport {
  return !!score && score.promptHash === hashPrompt(draft) && score.rubricVersion === RUBRIC_VERSION;
}

export const GatePolicy = {
  decide(rules: RuleReport, score: ScoreReport | null, settings: GateSettings): GateDecision {
    if (!settings.gateSending) return { action: "send", reasons: [] };
    const reasons: string[] = [];
    if (!score && settings.scoreRequired !== false) reasons.push("A current specification score is unavailable.");
    else if (score && score.score < settings.threshold) reasons.push("The specification score is below the confirmation threshold.");
    if (rules.findings.some(f => f.category === "privacy" || f.rule === "placeholder" || f.category === "risk" || f.severity === "error")) {
      reasons.push("The prompt has safety findings or unfilled placeholders.");
    }
    if (settings.scoreRequired === false && rules.findings.some(f => f.severity === "warning" || f.severity === "error") && reasons.length === 0) {
      reasons.push("The local checks found details worth clarifying.");
    }
    return { action: reasons.length ? "confirm" : "send", reasons };
  },
};

/** Send orchestration owns freshness and a hard deadline, including providers that ignore abort. */
export class SessionService {
  constructor(private readonly quick: (draft: string, signal: AbortSignal) => Promise<ScoreReport | null>, private readonly timeoutMs = 8000) {}
  async prepare(draft: string, rules: RuleReport, score: ScoreReport | null, settings: GateSettings): Promise<{ score: ScoreReport | null; decision: GateDecision }> {
    let current = isFreshScore(score, draft) ? score : null;
    if (settings.gateSending && !current) {
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        current = await Promise.race([
          this.quick(draft, ctrl.signal),
          new Promise<null>(resolve => { timer = setTimeout(() => { ctrl.abort(); resolve(null); }, this.timeoutMs); }),
        ]);
        if (!isFreshScore(current, draft)) current = null;
      } catch { current = null; }
      finally { clearTimeout(timer); }
    }
    return { score: current, decision: GatePolicy.decide(rules, current, settings) };
  }
}
