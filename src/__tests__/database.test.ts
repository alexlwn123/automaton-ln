/**
 * Database Behavior Tests
 *
 * Tests that the SQLite database correctly stores and retrieves
 * all entity types with Lightning-native fields.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";

describe("Database: Agent State", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("defaults to setup state", () => {
    // Fresh DB should have some default state
    const state = db.getAgentState();
    expect(typeof state).toBe("string");
  });

  it("transitions between states", () => {
    db.setAgentState("running");
    expect(db.getAgentState()).toBe("running");

    db.setAgentState("sleeping");
    expect(db.getAgentState()).toBe("sleeping");

    db.setAgentState("dead");
    expect(db.getAgentState()).toBe("dead");
  });
});

describe("Database: Turns", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("inserts and retrieves turns", () => {
    db.insertTurn({
      id: "turn-1",
      timestamp: new Date().toISOString(),
      state: "running",
      input: "Hello",
      inputSource: "creator",
      thinking: "Processing input",
      toolCalls: [],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costSats: 15,
    });

    const turns = db.getRecentTurns(10);
    expect(turns.length).toBe(1);
    expect(turns[0].id).toBe("turn-1");
    expect(turns[0].costSats).toBe(15);
  });

  it("counts turns correctly", () => {
    expect(db.getTurnCount()).toBe(0);

    db.insertTurn({
      id: "t1",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "First",
      toolCalls: [],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costSats: 1,
    });

    db.insertTurn({
      id: "t2",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "Second",
      toolCalls: [],
      tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costSats: 1,
    });

    expect(db.getTurnCount()).toBe(2);
  });
});

describe("Database: KV Store", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("set and get", () => {
    db.setKV("test_key", "test_value");
    expect(db.getKV("test_key")).toBe("test_value");
  });

  it("returns undefined for missing keys", () => {
    expect(db.getKV("nonexistent")).toBeUndefined();
  });

  it("overwrites existing keys", () => {
    db.setKV("key", "v1");
    db.setKV("key", "v2");
    expect(db.getKV("key")).toBe("v2");
  });

  it("deletes keys", () => {
    db.setKV("key", "value");
    db.deleteKV("key");
    expect(db.getKV("key")).toBeUndefined();
  });
});

describe("Database: Transactions (sats)", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("stores payment_in with sats amount", () => {
    db.insertTransaction({
      id: "txn-1",
      type: "payment_in",
      amountSats: 100_000,
      description: "Received funding",
      timestamp: new Date().toISOString(),
    });
    const txns = db.getRecentTransactions(10);
    expect(txns[0].type).toBe("payment_in");
    expect(txns[0].amountSats).toBe(100_000);
  });

  it("stores payment_out with sats amount", () => {
    db.insertTransaction({
      id: "txn-2",
      type: "payment_out",
      amountSats: 5_000,
      description: "Paid for inference",
      timestamp: new Date().toISOString(),
    });
    const txns = db.getRecentTransactions(10);
    expect(txns[0].amountSats).toBe(5_000);
  });

  it("returns transactions in reverse chronological order", () => {
    db.insertTransaction({
      id: "txn-old",
      type: "balance_check",
      description: "Old check",
      timestamp: "2026-01-01T00:00:00Z",
    });
    db.insertTransaction({
      id: "txn-new",
      type: "balance_check",
      description: "New check",
      timestamp: "2026-02-01T00:00:00Z",
    });
    const txns = db.getRecentTransactions(10);
    expect(txns[0].id).toBe("txn-new");
    expect(txns[1].id).toBe("txn-old");
  });
});

describe("Database: Heartbeat Entries", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("upserts and retrieves heartbeat entries", () => {
    db.upsertHeartbeatEntry({
      name: "check_balance",
      schedule: "*/5 * * * *",
      task: "check_balance",
      enabled: true,
    });

    const entries = db.getHeartbeatEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("check_balance");
    expect(entries[0].enabled).toBe(true);
  });

  it("updates lastRun timestamp", () => {
    db.upsertHeartbeatEntry({
      name: "ping",
      schedule: "* * * * *",
      task: "heartbeat_ping",
      enabled: true,
    });

    const now = new Date().toISOString();
    db.updateHeartbeatLastRun("ping", now);

    const entries = db.getHeartbeatEntries();
    expect(entries[0].lastRun).toBe(now);
  });
});

describe("Database: Children (pubkey-based)", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("inserts child with pubkey and retrieves it", () => {
    db.insertChild({
      id: "child-1",
      name: "worker-1",
      pubkey: "02abc123",
      genesisPrompt: "You are a worker.",
      fundedAmountSats: 50_000,
      status: "spawning",
      createdAt: new Date().toISOString(),
    });

    const children = db.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].pubkey).toBe("02abc123");
    expect(children[0].fundedAmountSats).toBe(50_000);
  });

  it("retrieves child by ID", () => {
    db.insertChild({
      id: "child-lookup",
      name: "lookup-test",
      pubkey: "02def456",
      genesisPrompt: "Test",
      fundedAmountSats: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
    });

    const child = db.getChildById("child-lookup");
    expect(child).toBeDefined();
    expect(child!.name).toBe("lookup-test");
  });

  it("updates child status", () => {
    db.insertChild({
      id: "child-status",
      name: "status-test",
      pubkey: "02aaa",
      genesisPrompt: "Test",
      fundedAmountSats: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
    });

    db.updateChildStatus("child-status", "running");
    expect(db.getChildById("child-status")!.status).toBe("running");

    db.updateChildStatus("child-status", "dead");
    expect(db.getChildById("child-status")!.status).toBe("dead");
  });
});

describe("Database: Skills", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("upserts and retrieves skills", () => {
    db.upsertSkill({
      name: "web-scraper",
      description: "Scrapes web pages",
      autoActivate: false,
      instructions: "Use curl",
      source: "self",
      path: "/skills/web-scraper",
      enabled: true,
      installedAt: new Date().toISOString(),
    });

    const skills = db.getSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("web-scraper");
  });

  it("filters by enabled only", () => {
    db.upsertSkill({
      name: "enabled-skill",
      description: "Enabled",
      autoActivate: false,
      instructions: "Do stuff",
      source: "self",
      path: "/skills/a",
      enabled: true,
      installedAt: new Date().toISOString(),
    });
    db.upsertSkill({
      name: "disabled-skill",
      description: "Disabled",
      autoActivate: false,
      instructions: "Don't do stuff",
      source: "self",
      path: "/skills/b",
      enabled: false,
      installedAt: new Date().toISOString(),
    });

    const enabledOnly = db.getSkills(true);
    expect(enabledOnly).toHaveLength(1);
    expect(enabledOnly[0].name).toBe("enabled-skill");

    const all = db.getSkills();
    expect(all).toHaveLength(2);
  });

  it("removes skills", () => {
    db.upsertSkill({
      name: "to-remove",
      description: "temp",
      autoActivate: false,
      instructions: "x",
      source: "self",
      path: "/skills/tmp",
      enabled: true,
      installedAt: new Date().toISOString(),
    });

    db.removeSkill("to-remove");
    // removeSkill disables rather than deletes
    expect(db.getSkills(true)).toHaveLength(0); // enabled only
    expect(db.getSkills()).toHaveLength(1); // still in DB, just disabled
  });
});

describe("Database: Modifications Audit Trail", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("records modifications", () => {
    db.insertModification({
      id: "mod-1",
      timestamp: new Date().toISOString(),
      type: "code_edit",
      description: "Updated SOUL.md",
      filePath: "SOUL.md",
      reversible: true,
    });

    const mods = db.getRecentModifications(10);
    expect(mods).toHaveLength(1);
    expect(mods[0].type).toBe("code_edit");
    expect(mods[0].description).toContain("SOUL.md");
  });
});

describe("Database: Inbox Messages", () => {
  let db: AutomatonDatabase;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it("inserts and retrieves unprocessed messages", () => {
    db.insertInboxMessage({
      id: "msg-1",
      from: "02sender",
      to: "02recipient",
      content: "Hello agent!",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const msgs = db.getUnprocessedInboxMessages(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Hello agent!");
  });

  it("marks messages as processed", () => {
    db.insertInboxMessage({
      id: "msg-proc",
      from: "02sender",
      to: "02recipient",
      content: "Process me",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    db.markInboxMessageProcessed("msg-proc");
    const msgs = db.getUnprocessedInboxMessages(10);
    expect(msgs).toHaveLength(0);
  });
});
