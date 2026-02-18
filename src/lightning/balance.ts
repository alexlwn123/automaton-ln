/**
 * Lightning Balance & Survival Tiers
 *
 * Monitors the automaton's financial health in sats.
 * If you can't pay, you die. This is not a punishment. It is physics.
 */

import type { FinancialState, SurvivalTier, AutomatonDatabase } from "../types.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import { getBalance } from "./payments.js";

/**
 * Check the current financial state of the automaton.
 */
export async function checkFinancialState(): Promise<FinancialState> {
  let balanceSats = 0;
  try {
    balanceSats = await getBalance();
  } catch {}

  return {
    balanceSats,
    lastChecked: new Date().toISOString(),
  };
}

/**
 * Determine the survival tier based on current balance in sats.
 */
export function getSurvivalTier(balanceSats: number): SurvivalTier {
  if (balanceSats > SURVIVAL_THRESHOLDS.normal) return "normal";
  if (balanceSats > SURVIVAL_THRESHOLDS.low_compute) return "low_compute";
  if (balanceSats > SURVIVAL_THRESHOLDS.critical) return "critical";
  return "dead";
}

/**
 * Format a balance for display.
 */
export function formatBalance(sats: number): string {
  if (sats >= 100_000_000) {
    return `₿${(sats / 100_000_000).toFixed(4)}`;
  }
  if (sats >= 1_000_000) {
    return `${(sats / 1_000_000).toFixed(2)}M sats`;
  }
  if (sats >= 1_000) {
    return `${(sats / 1_000).toFixed(1)}k sats`;
  }
  return `${sats} sats`;
}

/**
 * Log a balance check to the database.
 */
export function logBalanceCheck(
  db: AutomatonDatabase,
  state: FinancialState,
): void {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  db.insertTransaction({
    id: `${timestamp}-${random}`,
    type: "balance_check",
    amountSats: state.balanceSats,
    description: `Balance check: ${formatBalance(state.balanceSats)}`,
    timestamp: state.lastChecked,
  });
}
