/**
 * Agent Discovery
 *
 * Discover other agents via Nostr relays or agent card URIs.
 * Delegates to the Nostr registry module for relay queries,
 * with fallback to HTTP agent card fetching.
 */

import type {
  DiscoveredAgent,
  AgentCard,
} from "../types.js";
import {
  discoverAgentsNostr,
  searchAgentsNostr,
  fetchAgentByPubkey,
} from "./nostr.js";

/**
 * Discover agents by querying Nostr relays.
 */
export async function discoverAgents(
  limit: number = 20,
  _network?: string,
  relays?: string[],
): Promise<DiscoveredAgent[]> {
  return discoverAgentsNostr(relays, limit);
}

/**
 * Search for agents by keyword.
 */
export async function searchAgents(
  keyword: string,
  limit: number = 10,
  _network?: string,
  relays?: string[],
): Promise<DiscoveredAgent[]> {
  return searchAgentsNostr(keyword, relays, limit);
}

/**
 * Fetch a specific agent by pubkey.
 */
export async function fetchAgent(
  pubkey: string,
  relays?: string[],
): Promise<DiscoveredAgent | null> {
  return fetchAgentByPubkey(pubkey, relays);
}

/**
 * Fetch an agent card from a URI.
 */
export async function fetchAgentCard(
  uri: string,
): Promise<AgentCard | null> {
  try {
    let fetchUrl = uri;
    if (uri.startsWith("ipfs://")) {
      fetchUrl = `https://ipfs.io/ipfs/${uri.slice(7)}`;
    }

    const response = await fetch(fetchUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const card = (await response.json()) as AgentCard;
    if (!card.name || !card.type) return null;

    return card;
  } catch {
    return null;
  }
}
