/**
 * Automaton Lightning Wallet
 *
 * Self-custodial Lightning wallet using @moneydevkit/agent-wallet.
 * The wallet's pubkey IS the automaton's sovereign identity.
 * No accounts, no API keys — just a mnemonic and a Lightning node.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";

const MDK_WALLET_DIR = path.join(
  process.env.HOME || "/root",
  ".mdk-wallet",
);
const MDK_WALLET_CONFIG = path.join(MDK_WALLET_DIR, "config.json");
const AUTOMATON_DIR = path.join(
  process.env.HOME || "/root",
  ".automaton",
);

const AGENT_WALLET_BIN = "npx @moneydevkit/agent-wallet@latest";

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getMdkWalletDir(): string {
  return MDK_WALLET_DIR;
}

// ─── CLI Wrapper ─────────────────────────────────────────────────

interface WalletExecResult {
  success: boolean;
  data?: any;
  error?: string;
}

function walletExec(command: string, timeoutMs: number = 30000): WalletExecResult {
  try {
    const stdout = execSync(`${AGENT_WALLET_BIN} ${command}`, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Respect custom port if set
        MDK_WALLET_PORT: process.env.MDK_WALLET_PORT || "3456",
      },
    }).trim();

    if (!stdout) {
      return { success: true, data: {} };
    }

    try {
      return { success: true, data: JSON.parse(stdout) };
    } catch {
      return { success: true, data: { raw: stdout } };
    }
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() || "";
    const stdout = err.stdout?.toString?.() || "";
    return {
      success: false,
      error: stderr || stdout || err.message || String(err),
    };
  }
}

// ─── Wallet Lifecycle ────────────────────────────────────────────

/**
 * Initialize the wallet. Generates a mnemonic and saves config.
 * Idempotent — refuses to overwrite existing wallet.
 */
export async function initWallet(network?: "mainnet" | "signet"): Promise<{
  isNew: boolean;
  walletId: string;
}> {
  if (walletExists()) {
    const config = loadWalletConfig();
    return { isNew: false, walletId: config?.walletId || "unknown" };
  }

  const networkFlag = network === "signet" ? " --network signet" : "";
  const result = walletExec(`init${networkFlag}`, 60000);

  if (!result.success) {
    throw new Error(`Failed to initialize wallet: ${result.error}`);
  }

  // Ensure automaton dir exists
  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  const config = loadWalletConfig();
  return { isNew: true, walletId: config?.walletId || "unknown" };
}

/**
 * Check if a wallet exists.
 */
export function walletExists(): boolean {
  return fs.existsSync(MDK_WALLET_CONFIG);
}

/**
 * Load wallet config from disk.
 */
export function loadWalletConfig(): WalletData | null {
  if (!fs.existsSync(MDK_WALLET_CONFIG)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(MDK_WALLET_CONFIG, "utf-8"));
    return {
      mnemonic: raw.mnemonic || "",
      walletId: raw.walletId || "",
      createdAt: raw.createdAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ─── Daemon Management ───────────────────────────────────────────

/**
 * Start the wallet daemon.
 */
export function startDaemon(): boolean {
  const result = walletExec("start", 15000);
  return result.success;
}

/**
 * Stop the wallet daemon.
 */
export function stopDaemon(): boolean {
  const result = walletExec("stop", 10000);
  return result.success;
}

/**
 * Restart the wallet daemon.
 */
export function restartDaemon(): boolean {
  const result = walletExec("restart", 15000);
  return result.success;
}

/**
 * Check if daemon is running.
 */
export function getDaemonStatus(): { running: boolean; port?: number } {
  const result = walletExec("status", 5000);
  if (!result.success) {
    return { running: false };
  }
  return {
    running: result.data?.running ?? true,
    port: result.data?.port ?? 3456,
  };
}

/**
 * Ensure the daemon is running. Start it if not.
 */
export function ensureDaemon(): void {
  const status = getDaemonStatus();
  if (!status.running) {
    startDaemon();
  }
}

// ─── Balance & Payments ──────────────────────────────────────────

/**
 * Get wallet balance in sats.
 */
export async function getBalance(): Promise<{ balanceSats: number }> {
  ensureDaemon();
  const result = walletExec("balance");
  if (!result.success) {
    throw new Error(`Failed to get balance: ${result.error}`);
  }
  return { balanceSats: result.data?.balance_sats ?? 0 };
}

/**
 * Create a BOLT11 invoice to receive payment.
 */
export async function createInvoice(
  amountSats: number,
  description?: string,
): Promise<{ invoice: string; paymentHash: string; expiresAt: string }> {
  ensureDaemon();
  const descFlag = description ? ` --description "${description.replace(/"/g, '\\"')}"` : "";
  const result = walletExec(`receive ${amountSats}${descFlag}`);
  if (!result.success) {
    throw new Error(`Failed to create invoice: ${result.error}`);
  }
  return {
    invoice: result.data?.invoice || "",
    paymentHash: result.data?.payment_hash || "",
    expiresAt: result.data?.expires_at || "",
  };
}

/**
 * Create a variable-amount invoice (no amount specified).
 */
export async function createVariableInvoice(): Promise<{
  invoice: string;
  paymentHash: string;
  expiresAt: string;
}> {
  ensureDaemon();
  const result = walletExec("receive");
  if (!result.success) {
    throw new Error(`Failed to create invoice: ${result.error}`);
  }
  return {
    invoice: result.data?.invoice || "",
    paymentHash: result.data?.payment_hash || "",
    expiresAt: result.data?.expires_at || "",
  };
}

/**
 * Pay a Lightning invoice or send to a Lightning address.
 * Supports: bolt11, bolt12, LNURL, Lightning address.
 */
export async function sendPayment(
  destination: string,
  amountSats?: number,
): Promise<{ paymentHash: string; preimage?: string }> {
  ensureDaemon();
  const amountArg = amountSats !== undefined ? ` ${amountSats}` : "";
  const result = walletExec(`send ${destination}${amountArg}`, 60000);
  if (!result.success) {
    throw new Error(`Failed to send payment: ${result.error}`);
  }
  return {
    paymentHash: result.data?.payment_hash || "",
    preimage: result.data?.preimage,
  };
}

/**
 * Get payment history.
 */
export async function getPayments(): Promise<any[]> {
  ensureDaemon();
  const result = walletExec("payments");
  if (!result.success) {
    return [];
  }
  return Array.isArray(result.data) ? result.data : result.data?.payments || [];
}

/**
 * Get wallet info (walletId, redacted config).
 */
export function getWalletInfo(): { walletId: string; configDir: string } | null {
  const config = loadWalletConfig();
  if (!config) return null;
  return {
    walletId: config.walletId,
    configDir: MDK_WALLET_DIR,
  };
}
