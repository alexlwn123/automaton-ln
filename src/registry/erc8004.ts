/**
 * ERC-8004 Registry (LEGACY — disabled)
 *
 * This module previously registered agents on-chain via ERC-8004 on Base.
 * It has been replaced by Nostr-based discovery (NIP-89 agent cards).
 *
 * These stubs exist only for backward compatibility with any code that
 * still imports from this module. They all throw clear errors.
 *
 * TODO: Delete this file once all callers are migrated to src/registry/nostr.ts
 */

import type { AutomatonDatabase, RegistryEntry } from "../types.js";

export async function registerAgent(
  _identity: unknown,
  _agentURI: string,
  _network: string,
  _db: AutomatonDatabase,
): Promise<RegistryEntry> {
  throw new Error(
    "ERC-8004 registration is disabled. Use Nostr NIP-89 agent cards instead.",
  );
}

export async function updateAgentURI(
  _account: unknown,
  _agentId: string,
  _newAgentURI: string,
  _network: string,
  _db: AutomatonDatabase,
): Promise<string> {
  throw new Error(
    "ERC-8004 registration is disabled. Use Nostr NIP-89 agent cards instead.",
  );
}

export async function leaveFeedback(
  _account: unknown,
  _agentId: string,
  _score: number,
  _comment: string,
  _network: string,
  _db: AutomatonDatabase,
): Promise<string> {
  throw new Error(
    "ERC-8004 feedback is disabled. Use Nostr-based reputation instead.",
  );
}

export async function discoverAgents(
  _limit: number,
  _network: string,
): Promise<any[]> {
  throw new Error(
    "ERC-8004 discovery is disabled. Use Nostr relay queries instead.",
  );
}

export async function searchAgents(
  _keyword: string,
  _limit: number,
  _network: string,
): Promise<any[]> {
  throw new Error(
    "ERC-8004 search is disabled. Use Nostr relay queries instead.",
  );
}
