import * as vscode from "vscode";

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
