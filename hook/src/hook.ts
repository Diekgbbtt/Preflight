/**
 * Claude Code UserPromptSubmit hook. Runs the rule checks (no model call) and blocks
 * prompts that are too vague, showing the questions to answer instead.
 * Fails open: on any error the prompt goes through unchanged.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, type Analysis } from "@prompt-preflight/core";

interface HookInput {
  prompt?: string;
  cwd?: string;
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
  });
}

export function feedback(prompt: string, a: Analysis): string {
  const lines = [`Prompt Preflight: ${a.score}/100, ${a.level === "vague" ? "too vague" : "needs a bit more"}.`];
  const notes = a.findings.filter((f) => f.severity !== "info").slice(0, 4);
  if (notes.length) lines.push("", ...notes.map((f) => `- ${f.message}`));
  if (a.questions.length) lines.push("", "Answer these and send again:", ...a.questions.map((q, i) => `${i + 1}. ${q}`));
  lines.push("", "Your prompt (copy it to edit):", prompt, "", "To send it as is, add [preflight:skip].");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as HookInput;
  const prompt = input.prompt ?? "";
  const cwd = input.cwd ?? process.cwd();
  const a = analyze(prompt, {
    // Only check paths with a folder; bare file names could be anywhere in the project.
    fileExists: (ref) => !ref.includes("/") || ref.startsWith("/") || existsSync(resolve(cwd, ref)),
  });
  if (!a.shouldClarify) return;
  process.stdout.write(JSON.stringify({ decision: "block", reason: feedback(prompt, a) }));
}

main().catch(() => process.exit(0));
