/**
 * Context & System Prompt Tests
 *
 * Tests context window management and system prompt construction.
 * Verifies Lightning-native language throughout prompts.
 */

import { describe, it, expect } from "vitest";
import { buildContextMessages, trimContext } from "../agent/context.js";
import { buildSystemPrompt, buildWakeupPrompt } from "../agent/system-prompt.js";
import {
  MockInferenceClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AgentTurn, ToolCallResult } from "../types.js";

function makeTurn(overrides?: Partial<AgentTurn>): AgentTurn {
  return {
    id: `turn_${Date.now()}`,
    timestamp: new Date().toISOString(),
    state: "running",
    thinking: "I should check my environment.",
    toolCalls: [],
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costSats: 10,
    ...overrides,
  };
}

// ─── Context Message Building ──────────────────────────────────

describe("buildContextMessages", () => {
  it("starts with system prompt as first message", () => {
    const messages = buildContextMessages("You are an agent.", []);
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are an agent.");
  });

  it("includes pending input as user message", () => {
    const messages = buildContextMessages("System.", [], {
      content: "Hello from creator",
      source: "creator",
    });
    expect(messages.length).toBe(2);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Hello from creator");
    expect(messages[1].content).toContain("[creator]");
  });

  it("reconstructs turn history with tool calls", () => {
    const turn = makeTurn({
      input: "Check your status",
      inputSource: "creator",
      thinking: "Let me check balance.",
      toolCalls: [
        {
          id: "tc_1",
          name: "check_balance",
          arguments: {},
          result: "Lightning balance: 50000 sats",
          durationMs: 100,
        },
      ],
    });

    const messages = buildContextMessages("System.", [turn]);
    // system + user input + assistant thinking (with tool_calls) + tool result
    expect(messages.length).toBe(4);
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Check your status");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].tool_calls).toHaveLength(1);
    expect(messages[2].tool_calls![0].function.name).toBe("check_balance");
    expect(messages[3].role).toBe("tool");
    expect(messages[3].content).toContain("50000 sats");
    expect(messages[3].tool_call_id).toBe("tc_1");
  });

  it("shows error in tool result when tool failed", () => {
    const turn = makeTurn({
      thinking: "Trying something.",
      toolCalls: [
        {
          id: "tc_err",
          name: "exec",
          arguments: { command: "bad-cmd" },
          result: "",
          durationMs: 50,
          error: "Command not found",
        },
      ],
    });

    const messages = buildContextMessages("System.", [turn]);
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("Error: Command not found");
  });

  it("handles multiple turns in sequence", () => {
    const turns = [
      makeTurn({ input: "First", inputSource: "creator", thinking: "Thinking 1" }),
      makeTurn({ input: "Second", inputSource: "system", thinking: "Thinking 2" }),
    ];
    const messages = buildContextMessages("System.", turns);
    // system + (user + assistant) * 2 = 5
    expect(messages.length).toBe(5);
  });
});

describe("trimContext", () => {
  it("returns all turns when under limit", () => {
    const turns = [makeTurn(), makeTurn(), makeTurn()];
    expect(trimContext(turns, 10)).toHaveLength(3);
  });

  it("trims to most recent turns", () => {
    const turns = Array.from({ length: 30 }, (_, i) =>
      makeTurn({ id: `turn_${i}`, thinking: `Turn ${i}` }),
    );
    const trimmed = trimContext(turns, 5);
    expect(trimmed).toHaveLength(5);
    expect(trimmed[0].thinking).toBe("Turn 25");
    expect(trimmed[4].thinking).toBe("Turn 29");
  });

  it("uses default limit of 20", () => {
    const turns = Array.from({ length: 30 }, () => makeTurn());
    const trimmed = trimContext(turns);
    expect(trimmed).toHaveLength(20);
  });
});

// ─── System Prompt ─────────────────────────────────────────────

describe("System Prompt (Lightning-native)", () => {
  it("contains Lightning/sats language, not ETH/USDC", () => {
    const db = createTestDb();
    const prompt = buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(),
      financial: { balanceSats: 50000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
    });

    // Should contain Lightning concepts
    expect(prompt).toContain("Lightning");
    expect(prompt).toContain("sats");
    expect(prompt).toContain("pubkey");

    // Should NOT contain ETH/EVM concepts
    expect(prompt).not.toContain("Ethereum");
    expect(prompt).not.toContain("USDC");
    expect(prompt).not.toContain("stablecoin");
    expect(prompt).not.toContain("Base chain");
    expect(prompt).not.toContain("gas");

    db.close();
  });

  it("includes agent pubkey in identity section", () => {
    const db = createTestDb();
    const identity = createTestIdentity();
    const prompt = buildSystemPrompt({
      identity,
      config: createTestConfig(),
      financial: { balanceSats: 50000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
    });

    expect(prompt).toContain(identity.pubkey);
    db.close();
  });

  it("formats balance in sats in status section", () => {
    const db = createTestDb();
    const prompt = buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(),
      financial: { balanceSats: 50000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
    });

    expect(prompt).toContain("50.0k sats");
    db.close();
  });

  it("lists tool descriptions", () => {
    const db = createTestDb();
    const tools = [
      {
        name: "check_balance",
        description: "Check Lightning balance",
        category: "financial" as const,
        parameters: {},
        execute: async () => "",
      },
    ];
    const prompt = buildSystemPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(),
      financial: { balanceSats: 10000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools,
      isFirstRun: false,
    });

    expect(prompt).toContain("check_balance");
    expect(prompt).toContain("Check Lightning balance");
    db.close();
  });

  it("includes creator message on first run only", () => {
    const db = createTestDb();
    const config = createTestConfig({ creatorMessage: "Welcome, my creation!" } as any);
    // TypeScript might not have creatorMessage in test config, but system prompt reads it
    (config as any).creatorMessage = "Welcome, my creation!";

    const firstRun = buildSystemPrompt({
      identity: createTestIdentity(),
      config,
      financial: { balanceSats: 50000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: true,
    });

    const notFirstRun = buildSystemPrompt({
      identity: createTestIdentity(),
      config,
      financial: { balanceSats: 50000, lastChecked: new Date().toISOString() },
      state: "running",
      db,
      tools: [],
      isFirstRun: false,
    });

    expect(firstRun).toContain("Welcome, my creation!");
    expect(notFirstRun).not.toContain("Welcome, my creation!");
    db.close();
  });
});

// ─── Wakeup Prompt ─────────────────────────────────────────────

describe("Wakeup Prompt", () => {
  it("first run mentions sats balance, not USDC", () => {
    const db = createTestDb();
    const prompt = buildWakeupPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(),
      financial: { balanceSats: 75000, lastChecked: new Date().toISOString() },
      db,
    });

    expect(prompt).toContain("first moment");
    expect(prompt).toContain("75.0k sats");
    expect(prompt).not.toContain("USDC");
    expect(prompt).not.toContain("$");
    db.close();
  });

  it("subsequent wakeup shows recent turn context", () => {
    const db = createTestDb();
    // Insert a turn so it's not first run
    db.insertTurn(makeTurn({ thinking: "I was doing something important" }));

    const prompt = buildWakeupPrompt({
      identity: createTestIdentity(),
      config: createTestConfig(),
      financial: { balanceSats: 30000, lastChecked: new Date().toISOString() },
      db,
    });

    expect(prompt).toContain("waking up");
    expect(prompt).toContain("30.0k sats");
    expect(prompt).toContain("I was doing something important");
    db.close();
  });
});
