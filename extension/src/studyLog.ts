import * as vscode from "vscode";
import type { GapPriority, GapSource, PromptSession } from "@prompt-preflight/core";

export type GapCounts = Record<GapSource, Record<GapPriority, number>>;

/** Gaps counted by source and priority, e.g. { rules: { blocking: 0, important: 2, advisory: 1 }, ... }. */
export function gapCounts(gaps: Iterable<{ source: GapSource; priority: GapPriority }>): GapCounts {
  const zero = () => ({ blocking: 0, important: 0, advisory: 0 });
  const out: GapCounts = { rules: zero(), quick: zero(), deep: zero() };
  for (const g of gaps) out[g.source][g.priority]++;
  return out;
}

/** One summary entry for a finished prompt session. */
export function sessionEntry(s: PromptSession, finalMeter: { segments: number; label: string } | null): Record<string, unknown> {
  const records = [...s.gapHistory.values()];
  return {
    sessionId: s.id,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: new Date(s.endedAt ?? Date.now()).toISOString(),
    endedBy: s.endedBy,
    firstPrompt: s.revisions[0]?.text ?? "",
    finalPrompt: s.revisions[s.revisions.length - 1]?.text ?? "",
    revisions: s.revisions.length,
    gaps: {
      raised: gapCounts(records),
      answered: gapCounts(records.filter((r) => r.status === "answered")),
      dismissed: gapCounts(records.filter((r) => r.status === "dismissed")),
    },
    finalMeter: finalMeter && { segments: finalMeter.segments, label: finalMeter.label },
  };
}

/** Appends one JSON line per event to a local file. Only active when the user opts in. */
export class StudyLog {
  constructor(private readonly storage: vscode.Uri) {}

  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storage, "study-log.jsonl");
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration("promptPreflight").get<boolean>("studyLog.enabled", false);
  }

  async write(event: string, data: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    const participant = vscode.workspace.getConfiguration("promptPreflight").get<string>("studyLog.participantId", "");
    const line = JSON.stringify({ ts: new Date().toISOString(), event, participant, ...data }) + "\n";
    await vscode.workspace.fs.createDirectory(this.storage);
    let existing: Uint8Array = new Uint8Array();
    try {
      existing = await vscode.workspace.fs.readFile(this.uri);
    } catch {
      // first event
    }
    const add = new TextEncoder().encode(line);
    const next = new Uint8Array(existing.length + add.length);
    next.set(existing);
    next.set(add, existing.length);
    await vscode.workspace.fs.writeFile(this.uri, next);
  }
}
