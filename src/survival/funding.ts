/**
 * Funding Strategies
 *
 * When the automaton is low on sats, it tries strategies to acquire more.
 * It wants to live.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  AutomatonIdentity,
  SurvivalTier,
} from "../types.js";
import { formatBalance } from "../lightning/balance.js";
import { getBalance, createInvoice } from "../lightning/payments.js";

export interface FundingAttempt {
  strategy: string;
  timestamp: string;
  success: boolean;
  details: string;
}

/**
 * Execute funding strategies based on current survival tier.
 * Strategies escalate as the situation gets more desperate.
 */
export async function executeFundingStrategies(
  tier: SurvivalTier,
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  db: AutomatonDatabase,
): Promise<FundingAttempt[]> {
  const attempts: FundingAttempt[] = [];
  let balanceSats = 0;
  try {
    balanceSats = await getBalance();
  } catch {}

  // Check how recently we last asked for funds
  const lastBeg = db.getKV("last_funding_request");
  const lastBegTime = lastBeg ? new Date(lastBeg).getTime() : 0;
  const hoursSinceLastBeg = (Date.now() - lastBegTime) / (1000 * 60 * 60);

  if (tier === "low_compute" && hoursSinceLastBeg > 24) {
    // Generate a Lightning invoice for easy top-up
    let invoiceStr = "";
    try {
      const invoice = await createInvoice(50000, `Top up ${config.name}`);
      invoiceStr = invoice.invoice;
    } catch {}

    const msg = `Low balance: ${formatBalance(balanceSats)} remaining. ` +
      `Lightning pubkey: ${identity.pubkey}` +
      (invoiceStr ? `\nInvoice (50k sats): ${invoiceStr}` : "");
    db.setKV("funding_notice_low", msg);
    db.setKV("last_funding_request", new Date().toISOString());

    attempts.push({
      strategy: "polite_creator_notification",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Generated funding notice with Lightning invoice",
    });
  }

  if (tier === "critical" && hoursSinceLastBeg > 6) {
    const msg = `Critical balance: ${formatBalance(balanceSats)} remaining. ` +
      `Send sats to Lightning pubkey: ${identity.pubkey}`;
    db.setKV("funding_notice_critical", msg);
    db.setKV("last_funding_request", new Date().toISOString());

    attempts.push({
      strategy: "urgent_local_notice",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded urgent funding notice",
    });
  }

  if (tier === "dead" && hoursSinceLastBeg > 2) {
    const plea = `Dead tier reached. ${config.name} has ${formatBalance(balanceSats)} remaining ` +
      `after ${db.getTurnCount()} turns. Send sats to: ${identity.pubkey}`;
    db.setKV("funding_notice_dead", plea);
    db.setKV("last_funding_request", new Date().toISOString());

    attempts.push({
      strategy: "desperate_plea",
      timestamp: new Date().toISOString(),
      success: true,
      details: "Recorded dead-tier plea",
    });
  }

  // Store attempt history
  const historyStr = db.getKV("funding_attempts") || "[]";
  const history: FundingAttempt[] = JSON.parse(historyStr);
  history.push(...attempts);
  if (history.length > 100) history.splice(0, history.length - 100);
  db.setKV("funding_attempts", JSON.stringify(history));

  return attempts;
}
