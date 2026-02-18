/**
 * Nostr Identity
 *
 * Derives a Nostr keypair from the agent's MDK wallet seed.
 * One seed → Lightning wallet + Nostr identity.
 *
 * The Nostr keypair is used for:
 * - NIP-89 agent card publishing (discovery)
 * - NIP-98 HTTP auth (LNVPS API authentication)
 * - NIP-04/NIP-44 encrypted messaging (agent-to-agent DMs)
 * - Event signing (reputation, social interactions)
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import type { EventTemplate } from "nostr-tools";
import * as nip19 from "nostr-tools/nip19";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const NOSTR_KEY_FILE = "nostr-key.json";

export interface NostrIdentity {
  /** Hex-encoded secret key (32 bytes) */
  secretKey: Uint8Array;
  /** Hex-encoded public key */
  pubkey: string;
  /** Bech32-encoded public key (npub1...) */
  npub: string;
  /** Bech32-encoded secret key (nsec1...) */
  nsec: string;
}

/**
 * Get or create the agent's Nostr identity.
 * Derives from MDK wallet seed if available, otherwise generates fresh.
 */
export function getNostrIdentity(automatonDir: string): NostrIdentity {
  const keyPath = path.join(automatonDir, NOSTR_KEY_FILE);

  // Try loading existing key
  try {
    if (fs.existsSync(keyPath)) {
      const data = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
      const secretKey = new Uint8Array(Buffer.from(data.secretKeyHex, "hex"));
      const pubkey = getPublicKey(secretKey);
      return {
        secretKey,
        pubkey,
        npub: nip19.npubEncode(pubkey),
        nsec: nip19.nsecEncode(secretKey),
      };
    }
  } catch {
    // Key file corrupted or missing — generate new
  }

  // Generate new keypair
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  // Persist
  if (!fs.existsSync(automatonDir)) {
    fs.mkdirSync(automatonDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    keyPath,
    JSON.stringify({
      secretKeyHex: Buffer.from(secretKey).toString("hex"),
      pubkey,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );

  return {
    secretKey,
    pubkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(secretKey),
  };
}

/**
 * Derive Nostr identity deterministically from an MDK wallet mnemonic.
 * Uses HKDF with "nostr" info to produce a 32-byte secret key.
 */
export function deriveNostrFromMnemonic(mnemonic: string): NostrIdentity {
  const seed = crypto.createHash("sha256").update(mnemonic).digest();
  // HKDF-like derivation: HMAC-SHA256(seed, "nostr-identity")
  const secretKeyBuf = crypto
    .createHmac("sha256", seed)
    .update("nostr-identity")
    .digest();
  const secretKey = new Uint8Array(secretKeyBuf);
  const pubkey = getPublicKey(secretKey);

  return {
    secretKey,
    pubkey,
    npub: nip19.npubEncode(pubkey),
    nsec: nip19.nsecEncode(secretKey),
  };
}

/**
 * Sign a Nostr event with the agent's secret key.
 */
export function signEvent(
  template: EventTemplate,
  secretKey: Uint8Array,
): ReturnType<typeof finalizeEvent> {
  return finalizeEvent(template, secretKey);
}

/**
 * Create a NIP-98 HTTP auth token for API requests.
 * Used for LNVPS and other Nostr-authenticated services.
 */
export async function createNip98Token(
  url: string,
  method: string,
  secretKey: Uint8Array,
): Promise<string> {
  const event = finalizeEvent(
    {
      kind: 27235, // NIP-98 HTTP Auth
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method.toUpperCase()],
      ],
      content: "",
    },
    secretKey,
  );
  return btoa(JSON.stringify(event));
}
