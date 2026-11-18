import { migrate, type Clock, type Event, type IdGenerator, type Repository } from "@prompt-preflight/core";

export type StudyEventType = "send" | "score" | "review" | "agent-usage" | "outcome";
export interface StudyData {
  studySchemaVersion: 2;
  event: StudyEventType;
  participant: string;
  draftId: string;
  sendId: string;
  sessionId: string | null;
  reviewId?: string;
  [field: string]: unknown;
}
export interface StudyLinks { draftId: string; sendId: string; sessionId: string | null; reviewId?: string }

/** Generic repository envelope stays v1; study payload is independently versioned v2. */
export class StudyRecorder {
  constructor(private readonly repository: Repository<StudyData>, private readonly clock: Clock, private readonly id: IdGenerator) {}
  write(event: StudyEventType, links: StudyLinks, data: Record<string, unknown>, participant = ""): Promise<Event<StudyData>> {
    return this.repository.append({ provider: null, model: null, thinkingEffort: null, rubricVersion: null, scoreSource: null, latencyMs: null, contextManifestHash: null, tokens: null, cost: null, ...data, ...links, event, participant, studySchemaVersion: 2,
      id: this.id(), ts: new Date(this.clock.now()).toISOString() });
  }
}

/** Deterministic legacy IDs allow an interrupted migration to resume without duplicating rows. */
export function migrateStudyLog(text: string): { events: Event<StudyData>[]; skipped: number } {
  const events: Event<StudyData>[] = [];
  let skipped = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const old = JSON.parse(line);
      if (!old || typeof old !== "object" || old.event !== "send" || typeof old.ts !== "string") { skipped++; continue; }
      const id = `legacy-${index + 1}`;
      const result = migrate<StudyData>([{ schemaVersion: 0, seq: index + 1, id, ts: old.ts } as Event<StudyData>], {
        0: e => ({ ...e, schemaVersion: 1, studySchemaVersion: 2, event: "send", participant: typeof old.participant === "string" ? old.participant : "",
          draftId: id, sendId: id, sessionId: null,
          // Legacy scores were symbolic. Never expose them as model observations.
          scoreAvailable: false, firstScore: null, finalScore: null,
          legacyRuleScore: old.finalScore ?? null,
          ...(typeof old.prompt === "string" ? { text: old.prompt } : {}),
          preflightInputTokens: old.preflightInputTokens ?? 0, preflightOutputTokens: old.preflightOutputTokens ?? 0,
          preflightCostUsd: old.preflightCostUsd ?? 0,
          agentInputTokens: null, agentOutputTokens: null, agentCacheReadTokens: null, agentCacheCreationTokens: null, agentCostUsd: null,
        }),
      });
      events.push(...result.events); skipped += result.skipped;
    } catch { skipped++; }
  }
  return { events, skipped };
}
