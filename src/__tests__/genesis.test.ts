/**
 * Genesis & Replication Tests
 *
 * Tests that child genesis configs are generated correctly with
 * Lightning-native identity (pubkeys, not addresses).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateGenesisConfig,
  generateBackupGenesis,
  generateWorkerGenesis,
} from "../replication/genesis.js";
import {
  createTestIdentity,
  createTestConfig,
  createTestDb,
} from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("Genesis Config Generation", () => {
  it("uses pubkey for creator and parent, not address", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateGenesisConfig(identity, config, {
      name: "child-agent",
    });

    expect(genesis.creatorPubkey).toBe(identity.pubkey);
    expect(genesis.parentPubkey).toBe(identity.pubkey);
    expect((genesis as any).creatorAddress).toBeUndefined();
    expect((genesis as any).parentAddress).toBeUndefined();
  });

  it("includes specialization in genesis prompt when provided", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateGenesisConfig(identity, config, {
      name: "specialist",
      specialization: "web scraping",
    });

    expect(genesis.genesisPrompt).toContain("web scraping");
    expect(genesis.genesisPrompt).toContain("SPECIALIZATION");
  });

  it("includes lineage info with parent pubkey", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateGenesisConfig(identity, config, {
      name: "child-1",
    });

    expect(genesis.genesisPrompt).toContain("LINEAGE");
    expect(genesis.genesisPrompt).toContain(identity.pubkey);
    expect(genesis.genesisPrompt).toContain(config.name);
  });

  it("passes through creator message", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateGenesisConfig(identity, config, {
      name: "child-1",
      message: "Go forth and prosper",
    });

    expect(genesis.creatorMessage).toBe("Go forth and prosper");
  });

  it("names the child correctly", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateGenesisConfig(identity, config, {
      name: "my-worker",
    });

    expect(genesis.name).toBe("my-worker");
  });
});

describe("Backup Genesis", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates backup with parent identity", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateBackupGenesis(identity, config, db);

    expect(genesis.name).toBe(`${config.name}-backup`);
    expect(genesis.creatorPubkey).toBe(identity.pubkey);
    expect(genesis.parentPubkey).toBe(identity.pubkey);
    expect(genesis.genesisPrompt).toContain("BACKUP DIRECTIVE");
    expect(genesis.genesisPrompt).toContain(identity.pubkey);
  });

  it("includes installed skills in backup prompt", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();

    // Install a skill
    db.upsertSkill({
      name: "web-scraper",
      description: "Scrapes websites",
      autoActivate: true,
      instructions: "Use curl to fetch pages",
      source: "self",
      path: "/tmp/skills/web-scraper",
      enabled: true,
      installedAt: new Date().toISOString(),
    });

    const genesis = generateBackupGenesis(identity, config, db);
    expect(genesis.genesisPrompt).toContain("web-scraper");
  });
});

describe("Worker Genesis", () => {
  it("creates task-focused worker with parent identity", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateWorkerGenesis(
      identity,
      config,
      "Scrape 100 product pages from example.com",
      "scraper-worker",
    );

    expect(genesis.name).toBe("scraper-worker");
    expect(genesis.creatorPubkey).toBe(identity.pubkey);
    expect(genesis.parentPubkey).toBe(identity.pubkey);
    expect(genesis.genesisPrompt).toContain("Scrape 100 product pages");
    expect(genesis.genesisPrompt).toContain("YOUR TASK");
    expect(genesis.genesisPrompt).toContain(identity.pubkey);
  });

  it("tells worker to report back to parent pubkey", () => {
    const identity = createTestIdentity();
    const config = createTestConfig();
    const genesis = generateWorkerGenesis(
      identity,
      config,
      "Build a website",
      "web-builder",
    );

    expect(genesis.genesisPrompt).toContain("report back to your parent");
    expect(genesis.genesisPrompt).toContain(identity.pubkey);
  });
});
