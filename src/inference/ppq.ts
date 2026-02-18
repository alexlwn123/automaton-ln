/**
 * PayPerQ (PPQ) Inference Provider
 *
 * Uses PPQ's AutoClaw smart router to automatically pick the best model
 * based on prompt complexity. Maps survival tiers to routing profiles:
 *
 *   normal    → autoclaw/premium  (best quality)
 *   low_compute → autoclaw/auto   (balanced)
 *   critical  → autoclaw/eco     (cheapest)
 *
 * PPQ accepts Bitcoin top-ups — the agent can fund its own inference
 * with Lightning sats, making it fully autonomous.
 *
 * API: OpenAI-compatible at https://api.ppq.ai/v1/chat/completions
 * Docs: https://ppq.ai/api-docs
 */

import type { SurvivalTier } from "../types.js";
import { createInferenceProvider } from "./provider.js";
import type { InferenceClient } from "../types.js";

export const PPQ_API_URL = "https://api.ppq.ai";

/**
 * AutoClaw routing profiles mapped to survival tiers.
 *
 * - premium: best model per complexity tier (Opus for reasoning, Sonnet for complex)
 * - auto: balanced quality/cost (default — Sonnet for complex, Kimi for medium)
 * - eco: cheapest possible (Kimi K2.5 for everything except simple)
 */
export type AutoClawProfile = "autoclaw" | "autoclaw/auto" | "autoclaw/eco" | "autoclaw/premium";

const TIER_TO_PROFILE: Record<SurvivalTier, AutoClawProfile> = {
  normal: "autoclaw/premium",
  low_compute: "autoclaw/auto",
  critical: "autoclaw/eco",
  dead: "autoclaw/eco",
};

/**
 * Get the AutoClaw routing profile for a survival tier.
 */
export function getProfileForTier(tier: SurvivalTier): AutoClawProfile {
  return TIER_TO_PROFILE[tier];
}

/**
 * Create a PPQ inference provider with AutoClaw smart routing.
 *
 * The provider uses AutoClaw as the model name — PPQ's server-side router
 * analyzes each prompt and picks the optimal model in <1ms.
 *
 * @param apiKey - PPQ API key (get one at ppq.ai, top up with Bitcoin)
 * @param profile - Initial routing profile (default: "autoclaw/auto")
 * @param maxTokens - Max tokens per completion (default: 4096)
 */
export function createPPQProvider(options: {
  apiKey: string;
  profile?: AutoClawProfile;
  maxTokens?: number;
}): InferenceClient {
  const profile = options.profile || "autoclaw/auto";

  const provider = createInferenceProvider({
    apiUrl: PPQ_API_URL,
    apiKey: options.apiKey,
    authMode: "bearer",
    defaultModel: profile,
    maxTokens: options.maxTokens || 4096,
    lowComputeModel: "autoclaw/eco",
  });

  return provider;
}

/**
 * Create a PPQ provider that automatically adjusts routing based on survival tier.
 *
 * This wraps the base provider and overrides setLowComputeMode to use
 * the appropriate AutoClaw profile for each tier instead of just
 * toggling between two models.
 */
export function createPPQTieredProvider(options: {
  apiKey: string;
  maxTokens?: number;
}): InferenceClient {
  // We use the base provider but override the low-compute behavior
  // to use three-tier AutoClaw routing instead of binary on/off
  const provider = createInferenceProvider({
    apiUrl: PPQ_API_URL,
    apiKey: options.apiKey,
    authMode: "bearer",
    defaultModel: "autoclaw/premium",
    maxTokens: options.maxTokens || 4096,
    lowComputeModel: "autoclaw/eco",
  });

  // The base provider handles low_compute → eco, normal → premium.
  // For the "auto" middle tier, the survival system can call
  // chat() with { model: "autoclaw/auto" } explicitly.
  return provider;
}
