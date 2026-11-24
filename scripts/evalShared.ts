// Helpers shared by the evaluation scripts. No main(): importing this never starts a run.

/** Identifiers a user typed: backticked words, camelCase, PascalCase with an inner capital, snake_case. */
export function draftIdentifiers(draft: string): string[] {
  const found = new Set<string>();
  for (const m of draft.matchAll(/`([^`\s]+)`/g)) found.add(m[1]);
  for (const m of draft.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const w = m[0];
    if (/[a-z][A-Z]/.test(w) || /[a-z0-9]_[a-z0-9]/i.test(w)) found.add(w);
  }
  return [...found];
}

/** Deterministic shuffle so the sheet order is reproducible but hides draft, tier and model. */
export function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
