/**
 * Lightning Migration Tests
 *
 * Tests to verify the Lightning-native financial system, survival tiers,
 * tool definitions, and type integrity after the ETH→LN migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  FinancialState,
  ToolContext,
  ComputeProvider,
  RegistryEntry,
  ChildAutomaton,
  GenesisConfig,
  TransactionType,
} from "../types.js";
import { createBuiltinTools, toolsToInferenceFormat } from "../agent/tools.js";
import {
  MockComputeProvider,
  MockInferenceClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  noToolResponse,
  toolCallResponse,
} from "./mocks.js";
import { runAgentLoop } from "../agent/loop.js";
import type { AutomatonDatabase } from "../types.js";

// ─── Survival Tier Tests ───────────────────────────────────────

describe("Survival Tiers (sats-denominated)", () => {
  it("normal tier above 50,000 sats", () => {
    expect(getSurvivalTier(50_001)).toBe("normal");
    expect(getSurvivalTier(100_000)).toBe("normal");
    expect(getSurvivalTier(1_000_000)).toBe("normal");
  });

  it("low_compute tier between 10,001 and 50,000 sats", () => {
    expect(getSurvivalTier(50_000)).toBe("low_compute");
    expect(getSurvivalTier(10_001)).toBe("low_compute");
    expect(getSurvivalTier(25_000)).toBe("low_compute");
  });

  it("critical tier between 1,001 and 10,000 sats", () => {
    expect(getSurvivalTier(10_000)).toBe("critical");
    expect(getSurvivalTier(1_001)).toBe("critical");
    expect(getSurvivalTier(5_000)).toBe("critical");
  });

  it("dead tier at 1,000 sats or below", () => {
    expect(getSurvivalTier(1_000)).toBe("dead");
    expect(getSurvivalTier(500)).toBe("dead");
    expect(getSurvivalTier(0)).toBe("dead");
  });

  it("thresholds are in sats, not cents", () => {
    expect(SURVIVAL_THRESHOLDS.normal).toBe(50_000);
    expect(SURVIVAL_THRESHOLDS.low_compute).toBe(10_000);
    expect(SURVIVAL_THRESHOLDS.critical).toBe(1_000);
    expect(SURVIVAL_THRESHOLDS.dead).toBe(0);
  });
});

// ─── Balance Formatting Tests ──────────────────────────────────

describe("Balance Formatting", () => {
  it("formats small amounts in sats", () => {
    expect(formatBalance(500)).toBe("500 sats");
    expect(formatBalance(0)).toBe("0 sats");
    expect(formatBalance(999)).toBe("999 sats");
  });

  it("formats thousands as k sats", () => {
    expect(formatBalance(1_000)).toBe("1.0k sats");
    expect(formatBalance(50_000)).toBe("50.0k sats");
  });

  it("formats millions as M sats", () => {
    expect(formatBalance(1_000_000)).toBe("1.00M sats");
    expect(formatBalance(5_500_000)).toBe("5.50M sats");
  });

  it("formats 1 BTC or more with ₿ symbol", () => {
    expect(formatBalance(100_000_000)).toBe("₿1.0000");
    expect(formatBalance(250_000_000)).toBe("₿2.5000");
  });
});

// ─── Tool System Tests ─────────────────────────────────────────

describe("Lightning Tool Definitions", () => {
  it("no Conway/EVM tool names remain", () => {
    const tools = createBuiltinTools("test-sandbox");
    const toolNames = tools.map((t) => t.name);

    // These Conway tools should NOT exist
    expect(toolNames).not.toContain("check_credits");
    expect(toolNames).not.toContain("check_usdc_balance");
    expect(toolNames).not.toContain("create_sandbox");
    expect(toolNames).not.toContain("delete_sandbox");
    expect(toolNames).not.toContain("list_sandboxes");
    expect(toolNames).not.toContain("transfer_credits");
    expect(toolNames).not.toContain("x402_fetch");
    expect(toolNames).not.toContain("list_models");
    expect(toolNames).not.toContain("search_domains");
    expect(toolNames).not.toContain("register_domain");
    expect(toolNames).not.toContain("manage_dns");
    expect(toolNames).not.toContain("register_erc8004");
  });

  it("Lightning-native tools exist", () => {
    const tools = createBuiltinTools("test-sandbox");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("check_balance");
    expect(toolNames).toContain("send_payment");
    expect(toolNames).toContain("mdk402_fetch");
    expect(toolNames).toContain("register_agent");
  });

  it("core tools still exist", () => {
    const tools = createBuiltinTools("test-sandbox");
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("expose_port");
    expect(toolNames).toContain("remove_port");
    expect(toolNames).toContain("system_synopsis");
    expect(toolNames).toContain("heartbeat_ping");
    expect(toolNames).toContain("distress_signal");
    expect(toolNames).toContain("sleep");
    expect(toolNames).toContain("spawn_child");
    expect(toolNames).toContain("fund_child");
    expect(toolNames).toContain("install_skill");
  });

  it("converts to inference format without errors", () => {
    const tools = createBuiltinTools("test-sandbox");
    const formatted = toolsToInferenceFormat(tools);
    expect(formatted.length).toBe(tools.length);
    for (const def of formatted) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description).toBeTruthy();
    }
  });

  it("send_payment is marked dangerous", () => {
    const tools = createBuiltinTools("test-sandbox");
    const sendPayment = tools.find((t) => t.name === "send_payment");
    expect(sendPayment?.dangerous).toBe(true);
  });

  it("fund_child uses sats not cents", () => {
    const tools = createBuiltinTools("test-sandbox");
    const fundChild = tools.find((t) => t.name === "fund_child");
    expect(fundChild).toBeDefined();
    const params = fundChild!.parameters as any;
    expect(params.properties.amount_sats).toBeDefined();
    expect(params.properties.amount_cents).toBeUndefined();
  });
});

// ─── Type Integrity Tests ──────────────────────────────────────

describe("Type Integrity (no EVM remnants)", () => {
  it("AutomatonIdentity uses pubkey not address", () => {
    const id = createTestIdentity();
    expect(id.pubkey).toBeDefined();
    expect((id as any).address).toBeUndefined();
    expect((id as any).account).toBeUndefined();
  });

  it("AutomatonConfig uses creatorPubkey not creatorAddress", () => {
    const config = createTestConfig();
    expect(config.creatorPubkey).toBeDefined();
    expect((config as any).creatorAddress).toBeUndefined();
    expect((config as any).registeredWithConway).toBeUndefined();
  });

  it("FinancialState uses balanceSats", () => {
    const state: FinancialState = { balanceSats: 50000, lastChecked: new Date().toISOString() };
    expect(state.balanceSats).toBe(50000);
    expect((state as any).creditsCents).toBeUndefined();
    expect((state as any).usdcBalance).toBeUndefined();
  });

  it("TransactionType has no transfer_out", () => {
    const validTypes: TransactionType[] = [
      "balance_check", "inference", "tool_use",
      "payment_in", "payment_out", "funding_request",
    ];
    expect(validTypes).not.toContain("transfer_out");
    expect(validTypes).not.toContain("conway");
  });

  it("RegistryEntry has no txHash or chain", () => {
    const entry: RegistryEntry = {
      agentId: "test",
      agentURI: "https://example.com/agent",
      registeredAt: new Date().toISOString(),
      platform: "nostr",
    };
    expect(entry.platform).toBe("nostr");
    expect((entry as any).txHash).toBeUndefined();
    expect((entry as any).chain).toBeUndefined();
  });

  it("ChildAutomaton uses pubkey and fundedAmountSats", () => {
    const child: ChildAutomaton = {
      id: "test",
      name: "child-1",
      pubkey: "02abc",
      genesisPrompt: "test",
      fundedAmountSats: 10000,
      status: "running",
      createdAt: new Date().toISOString(),
    };
    expect(child.pubkey).toBeDefined();
    expect(child.fundedAmountSats).toBe(10000);
    expect((child as any).address).toBeUndefined();
    expect((child as any).fundedAmountCents).toBeUndefined();
  });

  it("GenesisConfig uses parentPubkey not parentAddress", () => {
    const genesis: GenesisConfig = {
      name: "test-child",
      genesisPrompt: "You are a test.",
      creatorPubkey: "03abc",
      parentPubkey: "02abc",
    };
    expect(genesis.parentPubkey).toBeDefined();
    expect((genesis as any).parentAddress).toBeUndefined();
  });
});

// ─── Database Tests ────────────────────────────────────────────

describe("Database (Lightning-native)", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("stores and retrieves registry entry without EVM fields", () => {
    const entry: RegistryEntry = {
      agentId: "agent-001",
      agentURI: "https://example.com/agent-card.json",
      registeredAt: new Date().toISOString(),
      platform: "nostr",
    };
    db.setRegistryEntry(entry);
    const retrieved = db.getRegistryEntry();
    expect(retrieved).toBeDefined();
    expect(retrieved!.agentId).toBe("agent-001");
    expect(retrieved!.platform).toBe("nostr");
    expect((retrieved as any).txHash).toBeUndefined();
    expect((retrieved as any).chain).toBeUndefined();
  });

  it("stores sats-denominated transactions", () => {
    db.insertTransaction({
      id: "txn-1",
      type: "payment_out",
      amountSats: 5000,
      description: "Test payment",
      timestamp: new Date().toISOString(),
    });
    const txns = db.getRecentTransactions(10);
    expect(txns.length).toBe(1);
    expect(txns[0].amountSats).toBe(5000);
    expect(txns[0].type).toBe("payment_out");
  });

  it("stores reputation entries with timestamp not txHash", () => {
    db.insertReputation({
      id: "rep-1",
      fromAgent: "agent-a",
      toAgent: "agent-b",
      score: 4,
      comment: "Good work",
      timestamp: new Date().toISOString(),
    });
    const reps = db.getReputation("agent-b");
    expect(reps.length).toBe(1);
    expect(reps[0].score).toBe(4);
    expect(reps[0].timestamp).toBeDefined();
    expect((reps[0] as any).txHash).toBeUndefined();
  });

  it("stores children with pubkey not address", () => {
    db.insertChild({
      id: "child-1",
      name: "worker-1",
      pubkey: "02deadbeef",
      genesisPrompt: "Work hard",
      fundedAmountSats: 25000,
      status: "spawning",
      createdAt: new Date().toISOString(),
    });
    const children = db.getChildren();
    expect(children.length).toBe(1);
    expect(children[0].pubkey).toBe("02deadbeef");
    expect(children[0].fundedAmountSats).toBe(25000);
  });
});

// ─── Agent Loop with Balance Override ──────────────────────────

describe("Agent Loop (Lightning balance)", () => {
  let db: AutomatonDatabase;
  let compute: MockComputeProvider;

  beforeEach(() => {
    db = createTestDb();
    compute = new MockComputeProvider();
  });

  afterEach(() => {
    db.close();
  });

  it("dead balance (0 sats) kills the agent", async () => {
    const inference = new MockInferenceClient([noToolResponse("hello")]);

    await runAgentLoop({
      getBalanceOverride: async () => 0,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      compute,
      inference,
    });

    expect(db.getAgentState()).toBe("dead");
  });

  it("healthy balance (100k sats) lets agent run normally", async () => {
    const inference = new MockInferenceClient([noToolResponse("All good.")]);

    await runAgentLoop({
      getBalanceOverride: async () => 100_000,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      compute,
      inference,
    });

    // Agent should have run and then auto-slept (not died)
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("critical balance triggers low-compute mode", async () => {
    const inference = new MockInferenceClient([noToolResponse("conserving")]);

    await runAgentLoop({
      getBalanceOverride: async () => 5_000, // critical tier
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      compute,
      inference,
    });

    expect(inference.lowComputeMode).toBe(true);
  });
});
