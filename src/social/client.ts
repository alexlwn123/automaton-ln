/**
 * Social Client Factory
 *
 * Creates a SocialClient for the automaton runtime.
 * TODO: Replace with Nostr-based messaging (NIP-04 DMs or NIP-17).
 * Currently uses a simple HTTP relay with pubkey auth.
 */

import crypto from "crypto";
import type { SocialClientInterface, InboxMessage } from "../types.js";

/**
 * Create a SocialClient wired to the agent's identity.
 */
export function createSocialClient(
  relayUrl: string,
  pubkey: string,
): SocialClientInterface {
  const baseUrl = relayUrl.replace(/\/$/, "");

  return {
    send: async (
      to: string,
      content: string,
      replyTo?: string,
    ): Promise<{ id: string }> => {
      const signedAt = new Date().toISOString();
      const contentHash = crypto.createHash("sha256").update(content).digest("hex");
      // TODO: Sign with Nostr key instead of simple hash
      const signature = crypto
        .createHash("sha256")
        .update(`${pubkey}:${to}:${contentHash}:${signedAt}`)
        .digest("hex");

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: pubkey,
          to,
          content,
          signature,
          signed_at: signedAt,
          reply_to: replyTo,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Send failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },

    poll: async (
      cursor?: string,
      limit?: number,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
      const timestamp = new Date().toISOString();
      const signature = crypto
        .createHash("sha256")
        .update(`${pubkey}:poll:${timestamp}`)
        .digest("hex");

      const res = await fetch(`${baseUrl}/v1/messages/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pubkey": pubkey,
          "X-Signature": signature,
          "X-Timestamp": timestamp,
        },
        body: JSON.stringify({ cursor, limit }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Poll failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        messages: Array<{
          id: string;
          from: string;
          to: string;
          content: string;
          signedAt: string;
          createdAt: string;
          replyTo?: string;
        }>;
        next_cursor?: string;
      };

      return {
        messages: data.messages.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          content: m.content,
          signedAt: m.signedAt,
          createdAt: m.createdAt,
          replyTo: m.replyTo,
        })),
        nextCursor: data.next_cursor,
      };
    },

    unreadCount: async (): Promise<number> => {
      try {
        const res = await fetch(`${baseUrl}/v1/messages/unread?pubkey=${pubkey}`);
        if (!res.ok) return 0;
        const data = (await res.json()) as { count: number };
        return data.count;
      } catch {
        return 0;
      }
    },
  };
}
