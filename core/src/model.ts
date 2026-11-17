/**
 * Model provider contract: profiles, settings shape, pure profile resolution
 * and the provider factory. The Claude adapter itself lives in claudeCli.ts.
 */

import type { ModelRequest, ModelResponse, ReviewMode } from "./review";
import { createClaudeProvider } from "./claudeCli";

export type ProviderId = "claude" | "codex";

/**
 * Provider-native thinking effort. The value is passed through to the
 * inference request unchanged; each provider validates its own vocabulary.
 */
export type ThinkingEffort = string;

export interface ModelProfile {
  provider: ProviderId;
  model: string;
  thinkingEffort: ThinkingEffort;
}

/** Plain settings object the extension builds from vscode.workspace.getConfiguration. */
export interface Config {
  provider: ProviderId;
  model: string;
  thinkingEffort: ThinkingEffort;
  quickModel: string;
  deepModel: string;
  claudePath: string;
}

export interface ModelCapabilities {
  structuredOutput: boolean;
  thinkingEffort: boolean;
  maxContextTokens: number;
  /** USD per million tokens. */
  cost: { inputPerMTok: number; outputPerMTok: number };
  supportsInstructionFiles: boolean;
}

export type ProfileValidation = { ok: true } | { ok: false; message: string };

export interface ModelProvider {
  readonly capabilities: ModelCapabilities;
  validateProfile(profile: ModelProfile): ProfileValidation;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

/**
 * Resolves the mode's explicit profile from settings.
 * Provider is global only; model prefers the mode override, then the global
 * model, then the mode default (haiku for quick, sonnet for deep).
 */
export function resolveProfile(settings: Config, mode: ReviewMode): ModelProfile {
  const override = (mode === "quick" ? settings.quickModel : settings.deepModel).trim();
  const model = override || settings.model.trim() || (mode === "quick" ? "haiku" : "sonnet");
  return { provider: settings.provider, model, thinkingEffort: settings.thinkingEffort };
}

const CODEX_MESSAGE = "Codex provider is not implemented; use Claude.";

/** Seam for #10: rejects until the real Codex adapter lands. Module-private; createProvider is the public factory. */
function createCodexStubProvider(profile: ModelProfile): ModelProvider {
  void profile;
  return {
    capabilities: {
      structuredOutput: false,
      thinkingEffort: false,
      maxContextTokens: 0,
      cost: { inputPerMTok: 0, outputPerMTok: 0 },
      supportsInstructionFiles: false,
    },
    validateProfile: () => ({ ok: false, message: CODEX_MESSAGE }),
    complete: () => Promise.reject(new Error(CODEX_MESSAGE)),
  };
}

/** Factory, not a service: binds a resolved profile to a provider adapter. */
export function createProvider(profile: ModelProfile, config: Config): ModelProvider {
  if (profile.provider === "claude") return createClaudeProvider(profile, config);
  if (profile.provider === "codex") return createCodexStubProvider(profile);
  throw new Error(`Unknown model provider: ${String(profile.provider)}. Use "claude" or "codex".`);
}
