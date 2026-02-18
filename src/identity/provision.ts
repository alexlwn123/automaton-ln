/**
 * Automaton Provisioning
 *
 * Optional provisioning for hosted services.
 * Self-hosted automatons need no provisioning — just a wallet.
 */

import fs from "fs";
import path from "path";
import { walletExists, loadWalletConfig } from "./wallet.js";
import type { ProvisionResult } from "../types.js";

/**
 * Check if the automaton is provisioned (has a wallet).
 */
export function isProvisioned(): boolean {
  return walletExists();
}

/**
 * Load API key from ~/.automaton/config.json if it exists.
 * Only relevant for hosted providers (Conway, etc.)
 */
export function loadApiKeyFromConfig(): string | null {
  const configPath = path.join(
    process.env.HOME || "/root",
    ".automaton",
    "config.json",
  );
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * For self-hosted: "provisioning" is just confirming the wallet exists.
 */
export async function provision(): Promise<ProvisionResult> {
  const config = loadWalletConfig();
  if (!config) {
    throw new Error("No wallet found. Run wallet init first.");
  }
  return {
    apiKey: "",
    pubkey: config.walletId,
  };
}
