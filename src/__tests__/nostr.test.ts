/**
 * Nostr Identity & Registry Tests
 *
 * Tests Nostr keypair generation, persistence, NIP-98 token creation,
 * and agent card event construction — all without network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getPublicKey, verifyEvent } from "nostr-tools";
import {
  getNostrIdentity,
  deriveNostrFromMnemonic,
  signEvent,
  createNip98Token,
} from "../identity/nostr.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nostr-test-"));
}

describe("Nostr Identity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a valid keypair on first call", () => {
    const id = getNostrIdentity(tmpDir);
    expect(id.pubkey).toHaveLength(64); // hex
    expect(id.npub).toMatch(/^npub1/);
    expect(id.nsec).toMatch(/^nsec1/);
    expect(id.secretKey).toBeInstanceOf(Uint8Array);
    expect(id.secretKey.length).toBe(32);
  });

  it("persists and reloads the same keypair", () => {
    const id1 = getNostrIdentity(tmpDir);
    const id2 = getNostrIdentity(tmpDir);
    expect(id1.pubkey).toBe(id2.pubkey);
    expect(id1.npub).toBe(id2.npub);
  });

  it("stores key file with restricted permissions", () => {
    getNostrIdentity(tmpDir);
    const keyPath = path.join(tmpDir, "nostr-key.json");
    expect(fs.existsSync(keyPath)).toBe(true);
    const stat = fs.statSync(keyPath);
    // 0o600 = owner read/write only
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("pubkey matches secretKey via getPublicKey", () => {
    const id = getNostrIdentity(tmpDir);
    const derivedPubkey = getPublicKey(id.secretKey);
    expect(derivedPubkey).toBe(id.pubkey);
  });
});

describe("Nostr Identity from Mnemonic", () => {
  it("derives deterministic identity from mnemonic", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const id1 = deriveNostrFromMnemonic(mnemonic);
    const id2 = deriveNostrFromMnemonic(mnemonic);
    expect(id1.pubkey).toBe(id2.pubkey);
    expect(Buffer.from(id1.secretKey)).toEqual(Buffer.from(id2.secretKey));
  });

  it("different mnemonics produce different keys", () => {
    const id1 = deriveNostrFromMnemonic("apple banana cherry");
    const id2 = deriveNostrFromMnemonic("dog elephant frog");
    expect(id1.pubkey).not.toBe(id2.pubkey);
  });

  it("produces valid keypair", () => {
    const id = deriveNostrFromMnemonic("test mnemonic phrase");
    expect(id.pubkey).toHaveLength(64);
    expect(id.npub).toMatch(/^npub1/);
    const derivedPubkey = getPublicKey(id.secretKey);
    expect(derivedPubkey).toBe(id.pubkey);
  });
});

describe("Nostr Event Signing", () => {
  it("signs a valid event", () => {
    const tmpDir = makeTmpDir();
    const id = getNostrIdentity(tmpDir);

    const event = signEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "Hello from automaton!",
      },
      id.secretKey,
    );

    expect(event.pubkey).toBe(id.pubkey);
    expect(event.sig).toBeTruthy();
    expect(event.id).toBeTruthy();
    expect(verifyEvent(event)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates events with correct kind and content", () => {
    const tmpDir = makeTmpDir();
    const id = getNostrIdentity(tmpDir);

    const event = signEvent(
      {
        kind: 31990,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", "test-agent"], ["name", "TestBot"]],
        content: JSON.stringify({ name: "TestBot", type: "automaton" }),
      },
      id.secretKey,
    );

    expect(event.kind).toBe(31990);
    expect(event.tags).toContainEqual(["d", "test-agent"]);
    expect(JSON.parse(event.content).name).toBe("TestBot");
    expect(verifyEvent(event)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("NIP-98 HTTP Auth Token", () => {
  it("creates a base64-encoded signed event", async () => {
    const tmpDir = makeTmpDir();
    const id = getNostrIdentity(tmpDir);

    const token = await createNip98Token(
      "https://lnvps.net/api/v1/vm",
      "POST",
      id.secretKey,
    );

    // Should be valid base64
    const decoded = JSON.parse(atob(token));
    expect(decoded.kind).toBe(27235);
    expect(decoded.pubkey).toBe(id.pubkey);

    // Should have url and method tags
    const urlTag = decoded.tags.find((t: string[]) => t[0] === "u");
    const methodTag = decoded.tags.find((t: string[]) => t[0] === "method");
    expect(urlTag[1]).toBe("https://lnvps.net/api/v1/vm");
    expect(methodTag[1]).toBe("POST");

    // Should be a valid Nostr event
    expect(verifyEvent(decoded)).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses uppercase method in tag", async () => {
    const tmpDir = makeTmpDir();
    const id = getNostrIdentity(tmpDir);

    const token = await createNip98Token(
      "https://example.com/api",
      "get",
      id.secretKey,
    );

    const decoded = JSON.parse(atob(token));
    const methodTag = decoded.tags.find((t: string[]) => t[0] === "method");
    expect(methodTag[1]).toBe("GET");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
