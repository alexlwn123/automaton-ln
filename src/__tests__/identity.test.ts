/**
 * Identity & Nostr Tests
 *
 * Tests Nostr identity generation, derivation from mnemonic,
 * NIP-98 token creation, event signing, and key persistence.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getNostrIdentity,
  deriveNostrFromMnemonic,
  signEvent,
  createNip98Token,
} from "../identity/nostr.js";

describe("Nostr Identity", () => {
  const tmpDir = path.join(os.tmpdir(), `automaton-nostr-${Date.now()}`);

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe("getNostrIdentity", () => {
    it("generates a new identity when none exists", () => {
      const id = getNostrIdentity(tmpDir);
      expect(id.pubkey).toHaveLength(64); // hex
      expect(id.npub).toMatch(/^npub1/);
      expect(id.nsec).toMatch(/^nsec1/);
      expect(id.secretKey).toBeInstanceOf(Uint8Array);
      expect(id.secretKey.length).toBe(32);
    });

    it("persists identity to disk", () => {
      getNostrIdentity(tmpDir);
      const keyFile = path.join(tmpDir, "nostr-key.json");
      expect(fs.existsSync(keyFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(keyFile, "utf-8"));
      expect(data.secretKeyHex).toHaveLength(64);
      expect(data.pubkey).toHaveLength(64);
      expect(data.createdAt).toBeDefined();
    });

    it("loads the same identity on subsequent calls", () => {
      const first = getNostrIdentity(tmpDir);
      const second = getNostrIdentity(tmpDir);
      expect(second.pubkey).toBe(first.pubkey);
      expect(second.npub).toBe(first.npub);
    });

    it("creates directory if it doesn't exist", () => {
      const deepDir = path.join(tmpDir, "deep", "nested");
      const id = getNostrIdentity(deepDir);
      expect(id.pubkey).toHaveLength(64);
      expect(fs.existsSync(deepDir)).toBe(true);
    });
  });

  describe("deriveNostrFromMnemonic", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    it("derives a valid identity from mnemonic", () => {
      const id = deriveNostrFromMnemonic(mnemonic);
      expect(id.pubkey).toHaveLength(64);
      expect(id.npub).toMatch(/^npub1/);
      expect(id.nsec).toMatch(/^nsec1/);
    });

    it("is deterministic — same mnemonic always gives same keys", () => {
      const first = deriveNostrFromMnemonic(mnemonic);
      const second = deriveNostrFromMnemonic(mnemonic);
      expect(second.pubkey).toBe(first.pubkey);
      expect(second.nsec).toBe(first.nsec);
    });

    it("different mnemonics give different keys", () => {
      const other = deriveNostrFromMnemonic("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong");
      const first = deriveNostrFromMnemonic(mnemonic);
      expect(other.pubkey).not.toBe(first.pubkey);
    });
  });

  describe("signEvent", () => {
    it("signs an event with valid signature", () => {
      const id = getNostrIdentity(tmpDir);
      const signed = signEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [],
          content: "test event",
        },
        id.secretKey,
      );
      expect(signed.sig).toHaveLength(128); // hex signature
      expect(signed.pubkey).toBe(id.pubkey);
      expect(signed.id).toHaveLength(64); // event id
      expect(signed.content).toBe("test event");
    });

    it("produces different signatures for different content", () => {
      const id = getNostrIdentity(tmpDir);
      const ts = Math.floor(Date.now() / 1000);
      const sig1 = signEvent(
        { kind: 1, created_at: ts, tags: [], content: "hello" },
        id.secretKey,
      );
      const sig2 = signEvent(
        { kind: 1, created_at: ts, tags: [], content: "world" },
        id.secretKey,
      );
      expect(sig1.sig).not.toBe(sig2.sig);
      expect(sig1.id).not.toBe(sig2.id);
    });
  });

  describe("createNip98Token", () => {
    it("creates a base64-encoded NIP-98 auth token", async () => {
      const id = getNostrIdentity(tmpDir);
      const token = await createNip98Token(
        "https://lnvps.net/api/v1/vm",
        "POST",
        id.secretKey,
      );

      // Token should be valid base64
      const decoded = JSON.parse(atob(token));
      expect(decoded.kind).toBe(27235); // NIP-98 kind
      expect(decoded.pubkey).toBe(id.pubkey);
      expect(decoded.sig).toHaveLength(128);

      // Should have url and method tags
      const urlTag = decoded.tags.find((t: string[]) => t[0] === "u");
      const methodTag = decoded.tags.find((t: string[]) => t[0] === "method");
      expect(urlTag[1]).toBe("https://lnvps.net/api/v1/vm");
      expect(methodTag[1]).toBe("POST");
    });

    it("different URLs produce different tokens", async () => {
      const id = getNostrIdentity(tmpDir);
      const token1 = await createNip98Token("https://a.com/1", "GET", id.secretKey);
      const token2 = await createNip98Token("https://a.com/2", "GET", id.secretKey);
      expect(token1).not.toBe(token2);
    });
  });
});
