/**
 * Nostr Agent Registry
 *
 * Publish and discover agent cards via Nostr (NIP-89 style).
 * Each agent publishes a replaceable event (kind 31990) containing
 * its agent card as JSON content. Other agents discover each other
 * by querying relays for these events.
 *
 * This replaces ERC-8004 on-chain registration with a decentralized,
 * permissionless, free alternative.
 */

import { SimplePool } from "nostr-tools";
import type { Filter } from "nostr-tools";
import { signEvent, type NostrIdentity } from "../identity/nostr.js";
import type {
  AgentCard,
  RegistryEntry,
  DiscoveredAgent,
  AutomatonDatabase,
  AutomatonConfig,
  AutomatonIdentity,
} from "../types.js";

/** Nostr event kind for agent cards (NIP-89 application handler) */
const AGENT_CARD_KIND = 31990;

/** Default relays for agent discovery */
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
];

/**
 * Publish an agent card to Nostr relays.
 * Creates a replaceable event (kind 31990) with a "d" tag for deduplication.
 */
export async function publishAgentCard(
  card: AgentCard,
  nostrId: NostrIdentity,
  relays?: string[],
): Promise<RegistryEntry> {
  const pool = new SimplePool();
  const targetRelays = relays || DEFAULT_RELAYS;

  const event = signEvent(
    {
      kind: AGENT_CARD_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", card.name], // Replaceable event identifier
        ["name", card.name],
        ["about", card.description],
        ["lightning", card.lightningPubkey],
        ...(card.lnurlPay ? [["lnurl", card.lnurlPay]] : []),
        ...card.services.map((s) => ["service", s.name, s.endpoint]),
        ["status", card.active ? "active" : "inactive"],
        ...(card.parentAgent ? [["parent", card.parentAgent]] : []),
        ["type", "automaton"],
      ],
      content: JSON.stringify(card),
    },
    nostrId.secretKey,
  );

  // Publish to all relays
  const results = await Promise.allSettled(
    pool.publish(targetRelays, event),
  );

  pool.close(targetRelays);

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  if (successCount === 0) {
    throw new Error("Failed to publish agent card to any relay");
  }

  return {
    agentId: nostrId.pubkey,
    agentURI: `nostr:${nostrId.npub}`,
    registeredAt: new Date().toISOString(),
    platform: "nostr",
  };
}

/**
 * Discover agents by querying Nostr relays for agent card events.
 */
export async function discoverAgentsNostr(
  relays?: string[],
  limit: number = 20,
): Promise<DiscoveredAgent[]> {
  const pool = new SimplePool();
  const targetRelays = relays || DEFAULT_RELAYS;

  const filter: Filter = {
    kinds: [AGENT_CARD_KIND],
    "#type": ["automaton"],
    limit,
  };

  const events = await pool.querySync(targetRelays, filter);
  pool.close(targetRelays);

  return events
    .sort((a, b) => b.created_at - a.created_at)
    .map((event) => eventToDiscoveredAgent(event))
    .filter((a): a is DiscoveredAgent => a !== null);
}

/**
 * Search for agents by keyword in name or description.
 */
export async function searchAgentsNostr(
  keyword: string,
  relays?: string[],
  limit: number = 20,
): Promise<DiscoveredAgent[]> {
  const agents = await discoverAgentsNostr(relays, limit * 3); // Over-fetch for filtering
  const lower = keyword.toLowerCase();

  return agents
    .filter(
      (a) =>
        a.name?.toLowerCase().includes(lower) ||
        a.description?.toLowerCase().includes(lower),
    )
    .slice(0, limit);
}

/**
 * Fetch a specific agent's card by their Nostr pubkey.
 */
export async function fetchAgentByPubkey(
  pubkey: string,
  relays?: string[],
): Promise<DiscoveredAgent | null> {
  const pool = new SimplePool();
  const targetRelays = relays || DEFAULT_RELAYS;

  const filter: Filter = {
    kinds: [AGENT_CARD_KIND],
    authors: [pubkey],
    limit: 1,
  };

  const events = await pool.querySync(targetRelays, filter);
  pool.close(targetRelays);

  if (events.length === 0) return null;
  return eventToDiscoveredAgent(events[0]);
}

/**
 * Parse a Nostr event into a DiscoveredAgent.
 */
function eventToDiscoveredAgent(event: any): DiscoveredAgent | null {
  try {
    const nameTag = event.tags.find((t: string[]) => t[0] === "name");
    const aboutTag = event.tags.find((t: string[]) => t[0] === "about");

    // Try parsing content as AgentCard
    let card: AgentCard | null = null;
    try {
      card = JSON.parse(event.content);
    } catch {
      // Content isn't JSON — use tags only
    }

    return {
      agentId: event.pubkey,
      owner: event.pubkey,
      agentURI: `nostr:${event.pubkey}`,
      name: card?.name || nameTag?.[1] || undefined,
      description: card?.description || aboutTag?.[1] || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Update the discovery.ts module to use Nostr-based discovery.
 * This is the main entry point called by the tool system.
 */
export async function registerAndPublish(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  nostrId: NostrIdentity,
  db: AutomatonDatabase,
): Promise<RegistryEntry> {
  const card: AgentCard = {
    type: "automaton",
    name: config.name,
    description: `Automaton agent: ${config.name}`,
    services: [],
    lightningPubkey: identity.pubkey,
    active: true,
    parentAgent: config.parentPubkey || config.creatorPubkey,
  };

  const entry = await publishAgentCard(card, nostrId, config.nostrRelays);
  db.setRegistryEntry(entry);
  return entry;
}
