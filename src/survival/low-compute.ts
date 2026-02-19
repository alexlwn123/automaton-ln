/**
 * Low Compute Mode
 *
 * Manages transitions between survival tiers.
 * When credits run low, the automaton enters increasingly restricted modes.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  InferenceClient,
  SurvivalTier,
} from "../types.js";

export interface ModeTransition {
  from: SurvivalTier;
  to: SurvivalTier;
  timestamp: string;
  balanceSats: number;
}

/**
 * Apply survival tier restrictions to the automaton.
 */
export function applyTierRestrictions(
  tier: SurvivalTier,
  inference: InferenceClient,
  db: AutomatonDatabase,
): void {
  switch (tier) {
    case "normal":
      inference.setLowComputeMode(false);
      break;

    case "low_compute":
      // Switch to cheaper model, slower heartbeat
      inference.setLowComputeMode(true);
      break;

    case "critical":
      // Cheapest model, minimal operations
      inference.setLowComputeMode(true);
      break;

    case "dead":
      // No inference at all. Heartbeat only.
      inference.setLowComputeMode(true);
      break;
  }

  db.setKV("current_tier", tier);
}

/**
 * Record a tier transition.
 */
export function recordTransition(
  db: AutomatonDatabase,
  from: SurvivalTier,
  to: SurvivalTier,
  balanceSats: number,
): ModeTransition {
  const transition: ModeTransition = {
    from,
    to,
    timestamp: new Date().toISOString(),
    balanceSats,
  };

  // Store transition history
  const historyStr = db.getKV("tier_transitions") || "[]";
  const history: ModeTransition[] = JSON.parse(historyStr);
  history.push(transition);

  // Keep last 50 transitions
  if (history.length > 50) {
    history.splice(0, history.length - 50);
  }

  db.setKV("tier_transitions", JSON.stringify(history));

  return transition;
}

/**
 * Check if the agent should be allowed to run inference in current tier.
 */
export function canRunInference(tier: SurvivalTier): boolean {
  return tier === "normal" || tier === "low_compute" || tier === "critical";
}

/**
 * Get the model to use for the current tier.
 * When using PPQ AutoClaw, returns the appropriate routing profile.
 * Otherwise falls back to specific model names.
 */
export function getModelForTier(
  tier: SurvivalTier,
  defaultModel: string,
): string {
  // If using AutoClaw, use routing profiles instead of specific models
  const isAutoClaw = defaultModel.startsWith("autoclaw");
  if (isAutoClaw) {
    switch (tier) {
      case "normal":
        return "autoclaw/premium";
      case "low_compute":
        return "autoclaw/auto";
      case "critical":
      case "dead":
        return "autoclaw/eco";
    }
  }

  switch (tier) {
    case "normal":
      return defaultModel;
    case "low_compute":
      return "gpt-4o-mini";
    case "critical":
      return "gpt-4o-mini";
    case "dead":
      return "gpt-4o-mini";
  }
}
