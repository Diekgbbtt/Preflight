import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { JsonlRepository } from "./repository";
import { migrateStudyLog, StudyRecorder, type StudyData, type StudyEventType, type StudyLinks } from "./studyEvents";

/** Opt-in append-only study events. No read/modify/write of the growing log. */
export class StudyLog {
  private readonly repository: JsonlRepository<StudyData>;
  private readonly recorder: StudyRecorder;
  private migration?: Promise<void>;
  constructor(private readonly storage: vscode.Uri) {
    this.repository = new JsonlRepository(path.join(storage.fsPath, "study-events-v2.jsonl"));
    this.recorder = new StudyRecorder(this.repository, { now: Date.now }, randomUUID);
  }
  get uri(): vscode.Uri { return vscode.Uri.joinPath(this.storage, "study-events-v2.jsonl"); }
  get enabled(): boolean { return vscode.workspace.getConfiguration("promptPreflight").get<boolean>("studyLog.enabled", false); }
  async write(event: StudyEventType, links: StudyLinks, data: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;
    if (!this.migration) this.migration = this.migrate().catch(e => { this.migration = undefined; throw e; });
    await this.migration;
    const participant = vscode.workspace.getConfiguration("promptPreflight").get<string>("studyLog.participantId", "");
    await this.recorder.write(event, links, data, participant);
  }
  private async migrate(): Promise<void> {
    let text: string;
    try { text = await fs.readFile(path.join(this.storage.fsPath, "study-log.jsonl"), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    const existing = new Set((await this.repository.list()).events.map(e => e.id));
    for (const event of migrateStudyLog(text).events) {
      if (!existing.has(event.id)) await this.repository.append(event);
    }
  }
}
