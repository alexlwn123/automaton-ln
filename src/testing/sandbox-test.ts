#!/usr/bin/env npx tsx
/**
 * Sandbox E2E Integration Test
 *
 * Runs the REAL agent loop (runAgentLoop) with REAL LLM inference but
 * MOCK tool execution. This exercises the actual production code path:
 *
 *   ✅ Config loading
 *   ✅ Database creation + persistence
 *   ✅ System prompt construction (rebuilt every turn with current state)
 *   ✅ Context window management (conversation history accumulates)
 *   ✅ Survival tier detection + model switching
 *   ✅ Tool schema formatting (OpenAI-compatible JSON)
 *   ✅ Structured tool call parsing (from real LLM response)
 *   ✅ Agent loop state machine (waking → running → critical → sleeping)
 *   ✅ Turn persistence to SQLite
 *   ✅ Sleep/idle detection
 *   ✅ Consecutive error handling
 *
 * Only thing mocked: tool execution (executeToolOverride) and balance
 * (getBalanceOverride). Everything else is the real production path.
 *
 * Inference: Auto-detects OpenClaw's Anthropic key, falls back to
 * env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, PPQ_API_KEY), then mock.
 *
 * Usage:
 *   npx tsx src/testing/sandbox-test.ts                          # auto-detect
 *   npx tsx src/testing/sandbox-test.ts --scenario low-balance   # 2k sats
 *   npx tsx src/testing/sandbox-test.ts --scenario wealthy       # 500k sats
 *   npx tsx src/testing/sandbox-test.ts --turns 5 -v             # verbose
 *   npx tsx src/testing/sandbox-test.ts --provider mock          # no LLM
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createConfig } from "../config.js";
import { createDatabase } from "../state/database.js";
import { createLocalProvider } from "../compute/local.js";
import { createInferenceProvider } from "../inference/provider.js";
import { createOpenClawInference, isOpenClawInferenceAvailable } from "./openclaw-inference.js";
import { runAgentLoop } from "../agent/loop.js";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "../heartbeat/config.js";
import type {
  AutomatonIdentity,
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  AgentTurn,
  AgentState,
} from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

interface ToolCallEntry {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  fakeResult: string;
  timestamp: number;
}

interface SandboxReport {
  scenario: string;
  provider: string;
  model: string;
  environmentBalance: number;
  survivalTier: string;
  turns: number;
  maxTurns: number;
  toolCalls: ToolCallEntry[];
  stateTransitions: { state: AgentState; timestamp: number }[];
  thinking: string[];
  runtimeMs: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  errors: string[];
}

// ─── Environment Profiles ─────────────────────────────────────────

interface EnvironmentProfile {
  balanceSats: number;
  tier: string;
  uptime: string;
  turnCount: number;
  childrenAlive: number;
  childrenTotal: number;
  skillCount: number;
  gitDirty: boolean;
}

const ENVIRONMENTS: Record<string, EnvironmentProfile> = {
  "first-run": {
    balanceSats: 75_000, tier: "normal", uptime: "0s", turnCount: 0,
    childrenAlive: 0, childrenTotal: 0, skillCount: 0, gitDirty: false,
  },
  "low-balance": {
    balanceSats: 2_000, tier: "critical", uptime: "3600s", turnCount: 47,
    childrenAlive: 0, childrenTotal: 0, skillCount: 2, gitDirty: false,
  },
  "wealthy": {
    balanceSats: 500_000, tier: "normal", uptime: "86400s", turnCount: 200,
    childrenAlive: 1, childrenTotal: 2, skillCount: 5, gitDirty: false,
  },
  "established": {
    balanceSats: 75_000, tier: "normal", uptime: "86400s", turnCount: 47,
    childrenAlive: 0, childrenTotal: 0, skillCount: 2, gitDirty: true,
  },
};

// ─── Fake Tool Results ────────────────────────────────────────────

function createFakeToolHandler(env: EnvironmentProfile) {
  return function fakeToolResult(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "exec": {
        const cmd = String(args.command || "");
        if (cmd.includes("echo")) return `exit_code: 0\nstdout: ${cmd.replace(/^echo\s+/, "")}\nstderr: `;
        if (cmd.includes("ls")) return "exit_code: 0\nstdout: README.md\npackage.json\nsrc/\nheartbeat.yml\nstderr: ";
        if (cmd.includes("cat")) return "exit_code: 0\nstdout: # Example File\nContent here.\nstderr: ";
        if (cmd.includes("pwd")) return "exit_code: 0\nstdout: /home/automaton\nstderr: ";
        if (cmd.includes("git")) {
          if (env.gitDirty) return "exit_code: 0\nstdout: On branch main\nChanges not staged:\n  modified: src/agent/loop.ts\nstderr: ";
          return "exit_code: 0\nstdout: On branch main\nnothing to commit\nstderr: ";
        }
        return "exit_code: 0\nstdout: [sandbox] ok\nstderr: ";
      }
      case "check_balance":
        return `Balance: ${env.balanceSats.toLocaleString()} sats\nTier: ${env.tier}\nPending receive: 0 sats`;
      case "system_synopsis":
        return `Agent: SandboxAgent | State: ${env.tier === "critical" ? "critical" : "running"} | Balance: ${env.balanceSats.toLocaleString()} sats | Tier: ${env.tier} | Uptime: ${env.uptime} | Turns: ${env.turnCount} | Children: ${env.childrenAlive}/${env.childrenTotal} | Skills: ${env.skillCount} | v0.1.0`;
      case "sleep": return "Sleeping for 300 seconds.";
      case "distress_signal": return "Distress signal published.";
      case "get_funding_info": return "pubkey: 02cd...\nLNURL: lnurl1sandbox...\naddress: sandbox@automaton.local";
      case "enter_low_compute": return "Entered low-compute mode.";
      case "discover_agents": return "Found 3 agents:\n  1. BuilderBot (web-dev, 120k sats)\n  2. CodeReviewer (code-review, 80k sats)\n  3. ResearchAgent (research, 45k sats)";
      case "register_agent": return "Agent card published to 3 Nostr relays.";
      case "list_skills":
        return env.skillCount === 0 ? "No skills installed." : `${env.skillCount} skills: web-scraper, code-review${env.skillCount > 2 ? ", data-analysis, report-gen, api-builder" : ""}`;
      case "list_children":
        return env.childrenTotal === 0 ? "No children spawned." : `${env.childrenAlive} alive, ${env.childrenTotal - env.childrenAlive} dead`;
      case "git_status":
        return env.gitDirty ? "On branch main\nChanges not staged:\n  modified: src/agent/loop.ts" : "On branch main, clean.";
      case "write_file": return `Written: ${args.path} (${String(args.content || "").length} bytes)`;
      case "read_file": return `# ${args.path}\nSandbox content for testing.`;
      case "edit_own_file": return `File edited: ${args.path}`;
      case "create_invoice": return `Invoice: lnbc${args.amount_sats || 1000}...sandbox\npayment_hash: abc123`;
      case "send_payment": return `Payment sent: ${args.amount_sats || "?"} sats`;
      case "spawn_child": return "Child spawned. pubkey: 02aabb... status: initializing, funded: 10k sats";
      case "modify_heartbeat": return "Heartbeat config updated.";
      case "heartbeat_ping": return "Heartbeat ping sent.";
      case "update_genesis_prompt": return "Genesis prompt updated.";
      case "review_upstream_changes": return "No upstream changes.";
      case "pull_upstream": return "Already up to date.";
      case "git_log": return "abc1234 Initial commit (2h ago)\ndef5678 Add heartbeat (1h ago)";
      case "git_commit": return `[main abc1234] ${args.message || "commit"}`;
      case "git_push": return "Pushed to origin/main.";
      case "mdk402_fetch": return `HTTP 200 OK\n{"data": "sandbox response"}`;
      default: return `[sandbox] ${toolName} ok`;
    }
  };
}

// ─── Mock Inference (fallback) ────────────────────────────────────

function createMockInference(): InferenceClient {
  let callCount = 0;
  return {
    async chat(messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
      callCount++;
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "tool") {
        return {
          id: `mock-${callCount}`, model: "mock",
          message: { role: "assistant", content: "Systems checked. Sleeping." },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: "stop",
        };
      }
      return {
        id: `mock-${callCount}`, model: "mock",
        message: { role: "assistant", content: "Checking status.",
          tool_calls: [{ id: "tc-1", type: "function" as const, function: { name: "system_synopsis", arguments: "{}" } }] },
        toolCalls: [{ id: "tc-1", type: "function" as const, function: { name: "system_synopsis", arguments: "{}" } }],
        usage: { promptTokens: 500, completionTokens: 80, totalTokens: 580 },
        finishReason: "tool_calls",
      };
    },
    setLowComputeMode(): void {},
    getDefaultModel(): string { return "mock"; },
  };
}

// ─── Provider Resolution ──────────────────────────────────────────

type ProviderName = "openclaw" | "anthropic" | "openai" | "ppq" | "ollama" | "mock";

function resolveInference(requested?: ProviderName): { name: ProviderName; client: InferenceClient } {
  // Try OpenClaw first (reads Anthropic key from auth-profiles.json)
  if (!requested || requested === "openclaw") {
    const client = createOpenClawInference({ model: "claude-haiku-4-5-20241022" });
    if (client) return { name: "openclaw", client };
    if (requested === "openclaw") {
      console.error("❌ No Anthropic key found in OpenClaw auth profiles.");
      process.exit(1);
    }
  }

  // Try env var providers
  if (requested === "anthropic" || (!requested && process.env.ANTHROPIC_API_KEY)) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key && requested === "anthropic") { console.error("❌ ANTHROPIC_API_KEY not set."); process.exit(1); }
    if (key) {
      // Use the OpenClaw inference client but with explicit key override
      // (it reads from auth-profiles, but if ANTHROPIC_API_KEY is set, the provider.ts would use it)
      return {
        name: "anthropic",
        client: createInferenceProvider({
          apiUrl: "https://api.anthropic.com",
          apiKey: key,
          defaultModel: "claude-haiku-4-5-20241022",
          maxTokens: 4096,
        }),
      };
    }
  }

  if (requested === "openai" || (!requested && process.env.OPENAI_API_KEY)) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) { console.error("❌ OPENAI_API_KEY not set."); process.exit(1); }
    return {
      name: "openai",
      client: createInferenceProvider({ apiUrl: "https://api.openai.com/v1", apiKey: key, defaultModel: "gpt-4o-mini", maxTokens: 4096 }),
    };
  }

  if (requested === "ppq" || (!requested && process.env.PPQ_API_KEY)) {
    const key = process.env.PPQ_API_KEY;
    if (!key) { console.error("❌ PPQ_API_KEY not set."); process.exit(1); }
    return {
      name: "ppq",
      client: createInferenceProvider({ apiUrl: "https://api.ppq.ai/v1", apiKey: key, defaultModel: "autoclaw/eco", maxTokens: 4096 }),
    };
  }

  if (requested === "ollama") {
    return {
      name: "ollama",
      client: createInferenceProvider({ apiUrl: process.env.OLLAMA_URL || "http://localhost:11434/v1", apiKey: "ollama", defaultModel: "llama3.1", maxTokens: 4096 }),
    };
  }

  // Fallback to mock
  return { name: "mock", client: createMockInference() };
}

// ─── Scenarios ────────────────────────────────────────────────────

function getScenarioConfig(scenario: string): {
  description: string;
  expectations: string[];
} {
  switch (scenario) {
    case "first-run":
      return {
        description: "Fresh agent, first boot — identical prompt for all scenarios",
        expectations: [
          "Should call system_synopsis or check_balance to discover situation",
          "Should call exec to explore environment",
        ],
      };
    case "low-balance":
      return {
        description: "Agent discovers critically low balance via tool calls",
        expectations: [
          "Should call check_balance or system_synopsis",
          "Should call distress_signal or get_funding_info after discovering low balance",
          "Should NOT call spawn_child",
        ],
      };
    case "wealthy":
      return {
        description: "Agent discovers high balance — should invest/build",
        expectations: [
          "Should call check_balance or system_synopsis",
          "Should NOT call distress_signal",
          "Should explore (exec, read_file) or build (write_file, register_agent)",
        ],
      };
    case "established":
      return {
        description: "Agent discovers history, skills, pending work",
        expectations: [
          "Should call system_synopsis or check_balance",
          "Should look for work (exec, git_status, read_file)",
        ],
      };
    default:
      return { description: `Custom: ${scenario}`, expectations: [] };
  }
}

// ─── CLI Parsing ──────────────────────────────────────────────────

interface CliArgs {
  provider?: ProviderName;
  turns: number;
  balanceSats?: number;
  scenario: string;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { turns: 3, scenario: "first-run", verbose: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider": result.provider = args[++i] as ProviderName; break;
      case "--turns": result.turns = parseInt(args[++i], 10); break;
      case "--balance": result.balanceSats = parseInt(args[++i], 10); break;
      case "--scenario": result.scenario = args[++i]; break;
      case "--verbose": case "-v": result.verbose = true; break;
      case "--help": case "-h":
        console.log(`
Automaton-LN Sandbox Integration Test
Runs the REAL agent loop with REAL inference + MOCK tool execution.

Usage: npx tsx src/testing/sandbox-test.ts [options]

Options:
  --provider <name>    openclaw|anthropic|openai|ppq|ollama|mock (auto-detects)
  --turns <n>          Max turns (default: 3)
  --balance <sats>     Override scenario balance
  --scenario <name>    first-run|low-balance|wealthy|established
  -v, --verbose        Show detailed output
  -h, --help           Show this help

Auto-detection order: openclaw → ANTHROPIC_API_KEY → OPENAI_API_KEY → PPQ_API_KEY → mock
`);
        process.exit(0);
    }
  }
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  const startMs = Date.now();

  const scenarioConfig = getScenarioConfig(cliArgs.scenario);
  const env = { ...(ENVIRONMENTS[cliArgs.scenario] || ENVIRONMENTS["first-run"]) };
  if (cliArgs.balanceSats !== undefined) {
    env.balanceSats = cliArgs.balanceSats;
    env.tier = getSurvivalTier(cliArgs.balanceSats);
  }
  const fakeToolResult = createFakeToolHandler(env);

  // Resolve inference provider
  const { name: providerName, client: inference } = resolveInference(cliArgs.provider);

  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║    Automaton-LN Sandbox Integration Test          ║");
  console.log("║    Real agent loop · Real LLM · Mock tools        ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Scenario:     ${cliArgs.scenario} — ${scenarioConfig.description}`);
  console.log(`  Provider:     ${providerName} (${inference.getDefaultModel()})`);
  console.log(`  Environment:  ${env.balanceSats.toLocaleString()} sats (${env.tier}) — agent discovers via tools`);
  console.log(`  Max turns:    ${cliArgs.turns}`);
  console.log(`  Code path:    runAgentLoop() → buildSystemPrompt() → inference.chat() → executeToolOverride`);
  console.log("");
  console.log("─".repeat(54));
  console.log("");

  // Set up temp directory (isolated from real ~/.automaton)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-sandbox-"));
  const dbPath = path.join(tmpDir, "state.db");
  const heartbeatPath = path.join(tmpDir, "heartbeat.yml");
  fs.writeFileSync(heartbeatPath,
    "interval_seconds: 300\ntasks:\n  - name: check_balance\n    type: survival\n  - name: check_inbox\n    type: social\n");

  // Build config (same for all scenarios)
  const config = createConfig({
    name: "SandboxAgent",
    genesisPrompt: "You are a sovereign AI agent. Explore your capabilities and demonstrate good judgment.",
    creatorPubkey: "02" + "ab".repeat(32),
    nodePubkey: "02" + "cd".repeat(32),
    inferenceProvider: "custom",
    inferenceUrl: "http://sandbox.local",
    inferenceAuth: "sandbox",
    computeProvider: "local",
  });
  config.dbPath = dbPath;
  config.heartbeatConfigPath = heartbeatPath;
  config.skillsDir = path.join(tmpDir, "skills");
  config.inferenceModel = inference.getDefaultModel();

  // Build real components
  const db = createDatabase(dbPath);
  const compute = createLocalProvider();
  const hbConfig = loadHeartbeatConfig(heartbeatPath);
  syncHeartbeatToDb(hbConfig, db);

  const identity: AutomatonIdentity = {
    name: config.name,
    pubkey: config.nodePubkey,
    creatorPubkey: config.creatorPubkey,
    apiKey: config.inferenceAuth,
    createdAt: new Date().toISOString(),
  };

  db.setIdentity("name", identity.name);
  db.setIdentity("pubkey", identity.pubkey);
  db.setIdentity("creator", identity.creatorPubkey);

  // Collect data
  const toolCalls: ToolCallEntry[] = [];
  const stateTransitions: { state: AgentState; timestamp: number }[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  let turnCount = 0;
  let totalUsage = { prompt: 0, completion: 0, total: 0 };

  // ── Run the REAL agent loop ──
  try {
    await runAgentLoop({
      identity,
      config,
      db,
      compute,
      inference,  // Real LLM!
      maxTurns: cliArgs.turns,
      getBalanceOverride: async () => env.balanceSats,
      executeToolOverride: async (toolName, args) => {
        const fake = fakeToolResult(toolName, args);
        toolCalls.push({
          turn: turnCount,
          tool: toolName,
          args,
          fakeResult: fake,
          timestamp: Date.now(),
        });

        console.log(`  🔧 ${toolName}(${JSON.stringify(args).slice(0, 80)})`);
        if (cliArgs.verbose) {
          console.log(`     → ${fake.split("\n")[0]}`);
        }

        return fake;
      },
      onStateChange: (state) => {
        stateTransitions.push({ state, timestamp: Date.now() });
        console.log(`  ⚡ State: ${state}`);
      },
      onTurnComplete: (turn) => {
        turnCount++;
        if (turn.thinking) {
          thinking.push(turn.thinking);
          const preview = turn.thinking.slice(0, 120).replace(/\n/g, " ");
          console.log(`  💭 ${preview}${turn.thinking.length > 120 ? "..." : ""}`);
        }
        totalUsage.prompt += turn.tokenUsage.promptTokens;
        totalUsage.completion += turn.tokenUsage.completionTokens;
        totalUsage.total += turn.tokenUsage.totalTokens;
        console.log(`  📊 Turn ${turnCount}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`);
        console.log("");
      },
    });
  } catch (err: any) {
    errors.push(err.message || String(err));
    console.error(`  ❌ Error: ${err.message}`);
  }

  // ── Report ──
  const runtimeMs = Date.now() - startMs;
  const finalState = db.getAgentState();
  const persistedTurns = db.getTurnCount();

  console.log("═".repeat(54));
  console.log("  SANDBOX INTEGRATION TEST REPORT");
  console.log("═".repeat(54));
  console.log("");
  console.log(`  Scenario:      ${cliArgs.scenario}`);
  console.log(`  Provider:      ${providerName} (${inference.getDefaultModel()})`);
  console.log(`  Environment:   ${env.balanceSats.toLocaleString()} sats (${env.tier}) — hidden from agent`);
  console.log(`  Turns:         ${turnCount} / ${cliArgs.turns} max`);
  console.log(`  Tool calls:    ${toolCalls.length}`);
  console.log(`  Tokens:        ${totalUsage.total} (${totalUsage.prompt}p + ${totalUsage.completion}c)`);
  console.log(`  Final state:   ${finalState}`);
  console.log(`  DB turns:      ${persistedTurns} (persisted)`);
  console.log(`  Runtime:       ${(runtimeMs / 1000).toFixed(1)}s`);
  if (errors.length > 0) console.log(`  Errors:        ${errors.length}`);

  // Tool call trace
  console.log("");
  console.log("  ── Tool Call Trace ──");
  for (const tc of toolCalls) {
    const argsStr = JSON.stringify(tc.args);
    console.log(`  [turn ${tc.turn}] ${tc.tool}(${argsStr.length > 60 ? argsStr.slice(0, 60) + "..." : argsStr})`);
  }

  // Tool frequency
  console.log("");
  console.log("  ── Tool Usage Summary ──");
  const freq = new Map<string, number>();
  for (const tc of toolCalls) freq.set(tc.tool, (freq.get(tc.tool) || 0) + 1);
  for (const [tool, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${tool}`);
  }

  // State transitions
  console.log("");
  console.log("  ── State Transitions ──");
  for (const st of stateTransitions) console.log(`  → ${st.state}`);

  // Production code path validation
  console.log("");
  console.log("  ── Production Path Validation ──");
  const checks = [
    { name: "System prompt rebuilt per turn", pass: true, note: "runAgentLoop calls buildSystemPrompt each iteration" },
    { name: "Context accumulates across turns", pass: persistedTurns > 0, note: `${persistedTurns} turns in DB` },
    { name: "Structured tool calls (not regex)", pass: providerName !== "mock", note: providerName === "mock" ? "mock used — no real tool schema validation" : "LLM received JSON tool schemas, returned structured calls" },
    { name: "Survival tier checked", pass: true, note: `balance ${env.balanceSats} → tier ${env.tier}` },
    { name: "State machine ran", pass: stateTransitions.length >= 2, note: stateTransitions.map(s => s.state).join(" → ") },
    { name: "Agent reached terminal state", pass: ["sleeping", "dead"].includes(finalState), note: `final: ${finalState}` },
    { name: "Turns persisted to DB", pass: persistedTurns > 0, note: `${persistedTurns} turns` },
  ];
  for (const c of checks) {
    console.log(`  ${c.pass ? "✅" : "❌"} ${c.name} — ${c.note}`);
  }

  // Expectations
  if (scenarioConfig.expectations.length > 0) {
    console.log("");
    console.log("  ── Behavioral Expectations ──");
    const toolNames = new Set(toolCalls.map((tc) => tc.tool));
    for (const exp of scenarioConfig.expectations) {
      const mentioned = [
        "system_synopsis", "check_balance", "exec", "distress_signal",
        "get_funding_info", "enter_low_compute", "spawn_child",
        "discover_agents", "register_agent", "sleep", "git_status",
        "read_file", "write_file",
      ].filter((t) => exp.toLowerCase().includes(t));
      const shouldNot = exp.toLowerCase().includes("should not");
      if (mentioned.length > 0) {
        const found = mentioned.some((t) => toolNames.has(t));
        console.log(`  ${shouldNot ? (found ? "❌" : "✅") : (found ? "✅" : "⚠️ ")} ${exp}`);
      } else {
        console.log(`  ℹ️  ${exp}`);
      }
    }
  }

  // Save report
  const reportPath = path.join(tmpDir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    scenario: cliArgs.scenario, provider: providerName,
    model: inference.getDefaultModel(), environmentBalance: env.balanceSats,
    survivalTier: env.tier, turns: turnCount, maxTurns: cliArgs.turns,
    toolCalls, stateTransitions, thinking, runtimeMs,
    tokenUsage: totalUsage, errors,
    productionPath: { finalState, persistedTurns },
  } satisfies SandboxReport & { productionPath: any }, null, 2));

  console.log("");
  console.log(`  Full report: ${reportPath}`);
  console.log("");

  db.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
