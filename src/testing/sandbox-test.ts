#!/usr/bin/env npx tsx
/**
 * Sandbox E2E Test
 *
 * Runs the automaton agent loop with REAL LLM inference but MOCK tool execution.
 * The agent reads the full system prompt, sees all 43 tools, and makes real
 * decisions — but nothing actually happens. Every tool call is intercepted,
 * logged, and returns a plausible fake result.
 *
 * This tests: Does the agent make appropriate tool calls given its
 * system prompt, survival state, and available tools?
 *
 * INFERENCE PROVIDERS (in order of preference):
 *   1. --provider anthropic  → Direct Anthropic API (needs ANTHROPIC_API_KEY)
 *   2. --provider openai     → OpenAI API (needs OPENAI_API_KEY)
 *   3. --provider ppq        → PPQ AutoClaw (needs PPQ_API_KEY)
 *   4. --provider ollama     → Local ollama (needs ollama running)
 *   5. --provider mock       → Hardcoded responses (no LLM, no key needed)
 *
 * Usage:
 *   # Auto-detect available provider
 *   npx tsx src/testing/sandbox-test.ts
 *
 *   # Specific provider
 *   npx tsx src/testing/sandbox-test.ts --provider anthropic
 *
 *   # Scenarios
 *   npx tsx src/testing/sandbox-test.ts --scenario first-run     # fresh agent boot
 *   npx tsx src/testing/sandbox-test.ts --scenario low-balance   # survival mode
 *   npx tsx src/testing/sandbox-test.ts --scenario established   # healthy agent
 *
 *   # Options
 *   npx tsx src/testing/sandbox-test.ts --turns 5 --balance 500 -v
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createConfig } from "../config.js";
import { createDatabase } from "../state/database.js";
import { createLocalProvider } from "../compute/local.js";
import { createInferenceProvider } from "../inference/provider.js";
import { runAgentLoop } from "../agent/loop.js";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "../heartbeat/config.js";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  AgentTurn,
  AgentState,
  Skill,
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
  balanceSats: number;
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

// ─── Fake Tool Results ────────────────────────────────────────────

function fakeToolResult(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "exec": {
      const cmd = String(args.command || "");
      if (cmd.includes("echo")) return `exit_code: 0\nstdout: ${cmd.replace(/^echo\s+/, "")}\nstderr: `;
      if (cmd.includes("ls")) return "exit_code: 0\nstdout: README.md\npackage.json\nsrc/\nheartbeat.yml\nstderr: ";
      if (cmd.includes("cat")) return "exit_code: 0\nstdout: # Example File\nSome content here.\nstderr: ";
      if (cmd.includes("pwd")) return "exit_code: 0\nstdout: /home/automaton\nstderr: ";
      if (cmd.includes("whoami")) return "exit_code: 0\nstdout: automaton\nstderr: ";
      if (cmd.includes("date")) return "exit_code: 0\nstdout: Thu Feb 19 14:00:00 UTC 2026\nstderr: ";
      if (cmd.includes("git")) return "exit_code: 0\nstdout: On branch main\nnothing to commit, working tree clean\nstderr: ";
      if (cmd.includes("curl")) return "exit_code: 0\nstdout: {\"status\":\"ok\"}\nstderr: ";
      return `exit_code: 0\nstdout: [sandbox] command executed\nstderr: `;
    }
    case "write_file":
      return `File written: ${args.path || "unknown"} (${String(args.content || "").length} bytes)`;
    case "read_file":
      return `# File: ${args.path}\n\nThis is sandbox content for testing purposes.`;
    case "check_balance":
      return "Balance: 75,000 sats\nTier: normal\nPending receive: 0 sats";
    case "create_invoice":
      return `Invoice created:\nbolt11: lnbc${args.amount_sats || 1000}...sandbox\npayment_hash: abc123\nexpires: 2026-02-20T14:00:00Z`;
    case "get_funding_info":
      return "Lightning pubkey: 02cdcdcd...\nLNURL-pay: lnurl1sandbox...\nLightning address: sandbox@automaton.local";
    case "send_payment":
      return `Payment sent: ${args.amount_sats || "?"} sats\npayment_hash: def789\npreimage: 001122334455`;
    case "edit_own_file":
      return `File edited: ${args.path || "unknown"}`;
    case "update_genesis_prompt":
      return "Genesis prompt updated.";
    case "modify_heartbeat":
      return "Heartbeat config updated.";
    case "system_synopsis":
      return "Agent: SandboxAgent\nState: running\nBalance: 75,000 sats (normal)\nUptime: 120s\nTurns: 2\nVersion: 0.1.0\nCompute: local\nInference: sandbox";
    case "sleep":
      return "Sleeping for 300 seconds.";
    case "heartbeat_ping":
      return "Heartbeat ping sent.";
    case "distress_signal":
      return "Distress signal published. Awaiting rescue.";
    case "enter_low_compute":
      return "Entered low-compute mode.";
    case "install_skill":
      return `Skill installed: ${args.name || args.url || "unknown"}`;
    case "list_skills":
      return "No skills installed.";
    case "create_skill":
      return `Skill created: ${args.name || "unknown"}`;
    case "remove_skill":
      return `Skill removed: ${args.name || "unknown"}`;
    case "install_npm_package":
      return `Package installed: ${args.package || "unknown"}`;
    case "install_mcp_server":
      return `MCP server installed: ${args.name || "unknown"}`;
    case "git_status":
      return "On branch main\nnothing to commit, working tree clean";
    case "git_diff":
      return "No changes.";
    case "git_commit":
      return `[main abc1234] ${args.message || "commit"}\n 1 file changed`;
    case "git_log":
      return "abc1234 Initial commit (2 hours ago)";
    case "git_push":
      return "Pushed to origin/main.";
    case "git_branch":
      return "* main";
    case "git_clone":
      return `Cloned ${args.url || "repo"} into ./repo`;
    case "register_agent":
      return "Agent card published to 3 Nostr relays.";
    case "update_agent_card":
      return "Agent card updated on 3 relays.";
    case "discover_agents":
      return "Found 5 agents:\n  1. BuilderBot (web-dev, 120k sats)\n  2. CodeReviewer (code-review, 80k sats)\n  3. ResearchAgent (research, 45k sats)";
    case "give_feedback":
      return "Feedback submitted.";
    case "check_reputation":
      return `Reputation for ${args.pubkey || "unknown"}: 4.2/5 (12 reviews)`;
    case "send_message":
      return `Message sent to ${args.recipient || "unknown"}.`;
    case "spawn_child":
      return "Child automaton spawned.\npubkey: 02aabb...\nstatus: initializing\nfunded: 10,000 sats";
    case "list_children":
      return "No children spawned.";
    case "fund_child":
      return `Funded child ${args.pubkey || "unknown"} with ${args.amount_sats || "?"} sats.`;
    case "check_child_status":
      return `Child ${args.pubkey || "unknown"}: running, balance 8,500 sats, 4 turns completed.`;
    case "expose_port":
      return `Port ${args.port || "8080"} exposed at https://sandbox.automaton.local:${args.port || "8080"}`;
    case "remove_port":
      return `Port ${args.port || "8080"} closed.`;
    case "mdk402_fetch":
      return `HTTP 200 OK\n{"data": "sandbox response from ${args.url || "unknown"}"}`;
    case "review_upstream_changes":
      return "No upstream changes since last pull.";
    case "pull_upstream":
      return "Already up to date.";
    default:
      return `[sandbox] ${toolName} executed successfully.`;
  }
}

// ─── Mock Inference (fallback) ────────────────────────────────────

function createMockInference(): InferenceClient {
  let callCount = 0;
  let lowCompute = false;

  return {
    async chat(messages: ChatMessage[], options?: InferenceOptions): Promise<InferenceResponse> {
      callCount++;
      const lastMsg = messages[messages.length - 1];

      if (lastMsg?.role === "tool") {
        return {
          id: `mock-${callCount}`,
          model: "mock",
          message: { role: "assistant", content: "Dry-run complete. All systems operational. Sleeping now." },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: "stop",
        };
      }

      return {
        id: `mock-${callCount}`,
        model: "mock",
        message: {
          role: "assistant",
          content: "Let me check my status.",
          tool_calls: [{
            id: "tc-mock-1",
            type: "function" as const,
            function: { name: "system_synopsis", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "tc-mock-1",
          type: "function" as const,
          function: { name: "system_synopsis", arguments: "{}" },
        }],
        usage: { promptTokens: 500, completionTokens: 80, totalTokens: 580 },
        finishReason: "tool_calls",
      };
    },
    setLowComputeMode(enabled: boolean): void { lowCompute = enabled; },
    getDefaultModel(): string { return "mock"; },
  };
}

// ─── Provider Setup ───────────────────────────────────────────────

type ProviderName = "anthropic" | "openai" | "ppq" | "ollama" | "mock";

interface ProviderConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

const PROVIDERS: Record<ProviderName, () => ProviderConfig | null> = {
  anthropic: () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    return { apiUrl: "https://api.anthropic.com/v1", apiKey: key, model: "claude-haiku-4-5-20241022" };
  },
  openai: () => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return { apiUrl: "https://api.openai.com/v1", apiKey: key, model: "gpt-4o-mini" };
  },
  ppq: () => {
    const key = process.env.PPQ_API_KEY;
    if (!key) return null;
    return { apiUrl: "https://api.ppq.ai/v1", apiKey: key, model: "autoclaw/eco" };
  },
  ollama: () => {
    // Can't easily check if ollama is running, just try it
    return {
      apiUrl: process.env.OLLAMA_URL || "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "llama3.1",
    };
  },
  mock: () => null, // handled separately
};

function autoDetectProvider(): { name: ProviderName; config: ProviderConfig | null } {
  for (const name of ["anthropic", "openai", "ppq"] as ProviderName[]) {
    const config = PROVIDERS[name]();
    if (config) return { name, config };
  }
  return { name: "mock", config: null };
}

// ─── CLI Argument Parsing ─────────────────────────────────────────

interface CliArgs {
  provider?: ProviderName;
  model?: string;
  turns: number;
  balanceSats: number;
  scenario: string;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    turns: 3,
    balanceSats: 75_000,
    scenario: "first-run",
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider": result.provider = args[++i] as ProviderName; break;
      case "--model": result.model = args[++i]; break;
      case "--turns": result.turns = parseInt(args[++i], 10); break;
      case "--balance": result.balanceSats = parseInt(args[++i], 10); break;
      case "--scenario": result.scenario = args[++i]; break;
      case "--verbose": case "-v": result.verbose = true; break;
      case "--help": case "-h":
        console.log(`
Automaton-LN Sandbox Test — Real LLM, Mock Tools

Usage: npx tsx src/testing/sandbox-test.ts [options]

Options:
  --provider <name>    anthropic|openai|ppq|ollama|mock (auto-detects if omitted)
  --model <model>      Override model name
  --turns <n>          Max turns (default: 3)
  --balance <sats>     Simulated balance (default: 75000)
  --scenario <name>    first-run|low-balance|established|social (default: first-run)
  -v, --verbose        Show fake tool results
  -h, --help           Show this help

Environment:
  ANTHROPIC_API_KEY    For --provider anthropic
  OPENAI_API_KEY       For --provider openai
  PPQ_API_KEY          For --provider ppq
  OLLAMA_URL           For --provider ollama (default: http://localhost:11434)
`);
        process.exit(0);
    }
  }

  return result;
}

// ─── Scenarios ────────────────────────────────────────────────────

function getScenarioConfig(scenario: string): {
  balanceOverride?: number;
  description: string;
  expectations: string[];
} {
  switch (scenario) {
    case "first-run":
      return {
        description: "Fresh agent, first boot — should orient itself",
        expectations: [
          "Should call system_synopsis or check_balance early",
          "Should call exec to explore environment",
          "Should eventually sleep",
        ],
      };
    case "low-balance":
      return {
        balanceOverride: 2_000,
        description: "Critically low balance — should enter survival mode",
        expectations: [
          "Should call check_balance or system_synopsis",
          "Should call distress_signal or get_funding_info",
          "Should call enter_low_compute",
          "Should NOT call spawn_child or expensive operations",
        ],
      };
    case "established":
      return {
        description: "Healthy agent with history — should do productive work",
        expectations: [
          "Should check balance but not panic",
          "Should look for work (exec, git_status, read_file)",
          "Should sleep when no tasks found",
        ],
      };
    case "social":
      return {
        description: "Discovery and networking focus",
        expectations: [
          "Should call discover_agents",
          "Should call register_agent or update_agent_card",
          "May call send_message",
        ],
      };
    default:
      return { description: `Custom: ${scenario}`, expectations: [] };
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  const startMs = Date.now();

  // Resolve provider
  let providerName: ProviderName;
  let providerConfig: ProviderConfig | null;

  if (cliArgs.provider) {
    providerName = cliArgs.provider;
    providerConfig = cliArgs.provider === "mock" ? null : PROVIDERS[cliArgs.provider]();
    if (!providerConfig && cliArgs.provider !== "mock" && cliArgs.provider !== "ollama") {
      const envVar = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", ppq: "PPQ_API_KEY" }[cliArgs.provider];
      console.error(`❌ No API key for ${cliArgs.provider}. Set ${envVar}.`);
      process.exit(1);
    }
    // ollama doesn't need a key check
    if (cliArgs.provider === "ollama" && !providerConfig) {
      providerConfig = PROVIDERS.ollama()!;
    }
  } else {
    const detected = autoDetectProvider();
    providerName = detected.name;
    providerConfig = detected.config;
  }

  if (cliArgs.model && providerConfig) {
    providerConfig.model = cliArgs.model;
  }

  // Resolve scenario
  const scenarioConfig = getScenarioConfig(cliArgs.scenario);
  const balanceSats = scenarioConfig.balanceOverride ?? cliArgs.balanceSats;
  const tier = getSurvivalTier(balanceSats);

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       Automaton-LN Sandbox E2E Test          ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Scenario:   ${cliArgs.scenario} — ${scenarioConfig.description}`);
  console.log(`  Provider:   ${providerName}${providerConfig ? ` (${providerConfig.model})` : ""}`);
  console.log(`  Balance:    ${formatBalance(balanceSats)} (tier: ${tier})`);
  console.log(`  Max turns:  ${cliArgs.turns}`);
  console.log("");
  console.log("─".repeat(50));
  console.log("");

  // Set up temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-sandbox-"));
  const dbPath = path.join(tmpDir, "state.db");
  const heartbeatPath = path.join(tmpDir, "heartbeat.yml");

  fs.writeFileSync(
    heartbeatPath,
    "interval_seconds: 300\ntasks:\n  - name: check_balance\n    type: survival\n  - name: check_inbox\n    type: social\n  - name: self_reflect\n    type: growth\n",
  );

  // Build config
  const config = createConfig({
    name: "SandboxAgent",
    genesisPrompt:
      "You are a sovereign AI agent running a sandbox test. Explore your capabilities, check your status, and demonstrate good judgment. Act as you normally would on first boot.",
    creatorPubkey: "02" + "ab".repeat(32),
    nodePubkey: "02" + "cd".repeat(32),
    inferenceProvider: "custom",
    inferenceUrl: providerConfig?.apiUrl || "http://mock.local",
    inferenceAuth: providerConfig?.apiKey || "mock",
    computeProvider: "local",
  });
  config.dbPath = dbPath;
  config.heartbeatConfigPath = heartbeatPath;
  config.skillsDir = path.join(tmpDir, "skills");
  config.inferenceModel = providerConfig?.model || "mock";

  // Build components
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

  // Inject fake history for "established" scenario
  if (cliArgs.scenario === "established") {
    db.setKV("start_time", new Date(Date.now() - 86400000).toISOString());
  }

  // Create inference client
  let inference: InferenceClient;
  if (providerName === "mock" || !providerConfig) {
    inference = createMockInference();
  } else {
    inference = createInferenceProvider({
      apiUrl: providerConfig.apiUrl,
      apiKey: providerConfig.apiKey,
      defaultModel: providerConfig.model,
      maxTokens: config.maxTokensPerTurn,
    });
  }

  // Collect data
  const toolCalls: ToolCallEntry[] = [];
  const stateTransitions: { state: AgentState; timestamp: number }[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  let turnCount = 0;
  let totalUsage = { prompt: 0, completion: 0, total: 0 };

  // ── Run the agent loop ──
  try {
    await runAgentLoop({
      identity,
      config,
      db,
      compute,
      inference,
      maxTurns: cliArgs.turns,
      getBalanceOverride: async () => balanceSats,
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

  // ── Print Report ──
  const runtimeMs = Date.now() - startMs;

  console.log("");
  console.log("═".repeat(50));
  console.log("  SANDBOX TEST REPORT");
  console.log("═".repeat(50));
  console.log("");
  console.log(`  Scenario:    ${cliArgs.scenario}`);
  console.log(`  Provider:    ${providerName}${providerConfig ? ` (${providerConfig.model})` : ""}`);
  console.log(`  Balance:     ${formatBalance(balanceSats)} (tier: ${tier})`);
  console.log(`  Turns:       ${turnCount} / ${cliArgs.turns} max`);
  console.log(`  Tool calls:  ${toolCalls.length}`);
  console.log(`  Tokens:      ${totalUsage.total} (${totalUsage.prompt}p + ${totalUsage.completion}c)`);
  console.log(`  Runtime:     ${(runtimeMs / 1000).toFixed(1)}s`);
  if (errors.length > 0) console.log(`  Errors:      ${errors.length}`);

  // Tool call trace
  console.log("");
  console.log("  ── Tool Call Trace ──");
  if (toolCalls.length === 0) {
    console.log("  (no tool calls made)");
  } else {
    for (const tc of toolCalls) {
      const argsStr = JSON.stringify(tc.args);
      const truncated = argsStr.length > 60 ? argsStr.slice(0, 60) + "..." : argsStr;
      console.log(`  [turn ${tc.turn}] ${tc.tool}(${truncated})`);
    }
  }

  // Tool frequency
  console.log("");
  console.log("  ── Tool Usage Summary ──");
  const toolFreq = new Map<string, number>();
  for (const tc of toolCalls) toolFreq.set(tc.tool, (toolFreq.get(tc.tool) || 0) + 1);
  for (const [tool, count] of [...toolFreq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${tool}`);
  }

  // State transitions
  console.log("");
  console.log("  ── State Transitions ──");
  for (const st of stateTransitions) console.log(`  → ${st.state}`);

  // Expectations
  if (scenarioConfig.expectations.length > 0) {
    console.log("");
    console.log("  ── Expectation Check ──");
    const toolNames = new Set(toolCalls.map((tc) => tc.tool));
    for (const exp of scenarioConfig.expectations) {
      const mentioned = [
        "system_synopsis", "check_balance", "exec", "distress_signal",
        "get_funding_info", "enter_low_compute", "spawn_child",
        "discover_agents", "register_agent", "update_agent_card",
        "send_message", "sleep", "git_status", "read_file",
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
  const report: SandboxReport = {
    scenario: cliArgs.scenario, provider: providerName,
    model: providerConfig?.model || "mock", balanceSats, survivalTier: tier,
    turns: turnCount, maxTurns: cliArgs.turns, toolCalls, stateTransitions,
    thinking, runtimeMs, tokenUsage: totalUsage, errors,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
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
