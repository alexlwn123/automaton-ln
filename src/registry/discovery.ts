/**
 * Agent Discovery
 *
 * Discover other agents via Nostr relays or agent card URIs.
 * TODO: Implement NIP-89 relay queries for agent discovery.
 */

import type {
  DiscoveredAgent,
  AgentCard,
} from "../types.js";

/**
 * Discover agents by querying Nostr relays.
 * TODO: Query NIP-89 events (kind 31990) from configured relays.
 */
export async function discoverAgents(
  limit: number = 20,
  _network?: string,
): Promise<DiscoveredAgent[]> {
  // TODO: Implement Nostr NIP-89 discovery
  // 1. Connect to configured relays
  // 2. Query for kind 31990 events
  // 3. Parse agent card data from event content
  // 4. Return as DiscoveredAgent[]
  return [];
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

/**
 * Search for agents by name or description.
 * TODO: Implement Nostr search via NIP-50 or local filtering.
 */
export async function searchAgents(
  _keyword: string,
  _limit: number = 10,
  _network?: string,
): Promise<DiscoveredAgent[]> {
  // TODO: Implement Nostr-based search
  return [];
}
