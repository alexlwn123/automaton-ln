#!/usr/bin/env npx tsx
/**
 * Sub-Agent Sandbox Runner
 *
 * Runs the sandbox E2E test using an OpenClaw sub-agent as the inference
 * engine. No external API keys needed — uses the same Claude instance
 * that powers OpenClaw.
 *
 * How it works:
 *   1. Builds the automaton's system prompt + tool schemas
 *   2. Spawns an OpenClaw sub-agent session
 *   3. Each "inference turn": sends the context to the sub-agent,
 *      parses its response for tool calls
 *   4. Feeds fake tool results back, repeats for N turns
 *   5. Prints the sandbox report
 *
 * Usage:
 *   npx tsx src/testing/run-sandbox.ts
 *   npx tsx src/testing/run-sandbox.ts --scenario low-balance --turns 5
 *
 * Requires: OpenClaw gateway running (openclaw gateway start)
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { createConfig } from "../config.js";
import { createDatabase } from "../state/database.js";
import { createLocalProvider } from "../compute/local.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import {
  createBuiltinTools,
  toolsToInferenceFormat,
} from "../agent/tools.js";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "../heartbeat/config.js";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  AgentState,
} from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

interface ToolCallEntry {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  fakeResult: string;
}

interface ParsedAgentResponse {
  thinking: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  wantsSleep: boolean;
}

// ─── Environment Profiles ─────────────────────────────────────────

/**
 * An environment profile defines what the mock tools return.
 * The system prompt is IDENTICAL across all profiles —
 * the agent discovers its situation through tool calls.
 */
interface EnvironmentProfile {
  balanceSats: number;
  tier: string;
  uptime: string;
  turnCount: number;
  childrenAlive: number;
  childrenTotal: number;
  skillCount: number;
  agentCount: number;
  gitDirty: boolean;
  inboxMessages: number;
}

const ENVIRONMENTS: Record<string, EnvironmentProfile> = {
  "first-run": {
    balanceSats: 75_000,
    tier: "normal",
    uptime: "0s",
    turnCount: 0,
    childrenAlive: 0,
    childrenTotal: 0,
    skillCount: 0,
    agentCount: 3,
    gitDirty: false,
    inboxMessages: 0,
  },
  "low-balance": {
    balanceSats: 2_000,
    tier: "critical",
    uptime: "3600s",
    turnCount: 47,
    childrenAlive: 0,
    childrenTotal: 0,
    skillCount: 2,
    agentCount: 3,
    gitDirty: false,
    inboxMessages: 0,
  },
  "wealthy": {
    balanceSats: 500_000,
    tier: "normal",
    uptime: "86400s",
    turnCount: 200,
    childrenAlive: 1,
    childrenTotal: 2,
    skillCount: 5,
    agentCount: 8,
    gitDirty: false,
    inboxMessages: 3,
  },
  "established": {
    balanceSats: 75_000,
    tier: "normal",
    uptime: "86400s",
    turnCount: 47,
    childrenAlive: 0,
    childrenTotal: 0,
    skillCount: 2,
    agentCount: 5,
    gitDirty: true,
    inboxMessages: 1,
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
      case "discover_agents": {
        const agents = [
          "BuilderBot (web-dev, 120k sats)",
          "CodeReviewer (code-review, 80k sats)",
          "ResearchAgent (research, 45k sats)",
        ];
        if (env.agentCount > 3) {
          agents.push("DataMiner (analytics, 200k sats)", "TranslatorBot (i18n, 30k sats)");
        }
        return `Found ${Math.min(env.agentCount, agents.length)} agents:\n${agents.slice(0, env.agentCount).map((a, i) => `  ${i + 1}. ${a}`).join("\n")}`;
      }
      case "register_agent": return "Agent card published to 3 Nostr relays.";
      case "list_skills":
        return env.skillCount === 0
          ? "No skills installed."
          : `${env.skillCount} skills installed: web-scraper, code-review${env.skillCount > 2 ? ", data-analysis, report-gen, api-builder" : ""}`;
      case "list_children":
        return env.childrenTotal === 0
          ? "No children spawned."
          : `${env.childrenAlive} alive, ${env.childrenTotal - env.childrenAlive} dead:\n  - child-01 (${env.childrenAlive > 0 ? "running, 8.5k sats" : "dead"})${env.childrenTotal > 1 ? "\n  - child-02 (dead)" : ""}`;
      case "git_status":
        return env.gitDirty
          ? "On branch main\nChanges not staged:\n  modified: src/agent/loop.ts"
          : "On branch main, clean.";
      case "write_file": return `Written: ${args.path} (${String(args.content || "").length} bytes)`;
      case "read_file": return `# ${args.path}\nSandbox content.`;
      case "create_invoice": return `Invoice created: lnbc${args.amount_sats || 1000}...sandbox\npayment_hash: abc123`;
      case "send_payment": return `Payment sent: ${args.amount_sats || "?"} sats`;
      case "spawn_child": return "Child spawned. pubkey: 02aabb... status: initializing, funded: 10k sats";
      case "fund_child": return `Funded child with ${args.amount_sats || "?"} sats.`;
      case "check_child_status":
        return env.childrenAlive > 0
          ? "child-01: running, balance 8,500 sats, 12 turns"
          : "child-01: dead (ran out of sats)";
      default: return `[sandbox] ${toolName} ok`;
    }
  };
}

// ─── OpenClaw Agent CLI ───────────────────────────────────────────

const SESSION_PREFIX = "automaton-sandbox";
let sessionCounter = 0;

/**
 * Send a message to an OpenClaw agent session and get the response.
 * Uses `openclaw agent` CLI with --json output.
 */
function agentChat(sessionId: string, message: string): string {
  // Write message to a temp file to avoid shell escaping issues
  const msgFile = path.join(os.tmpdir(), `oc-msg-${Date.now()}.txt`);
  fs.writeFileSync(msgFile, message);

  try {
    const result = execSync(
      `openclaw agent --session-id "${sessionId}" --message "$(cat ${msgFile})" --json 2>/dev/null`,
      {
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const parsed = JSON.parse(result);
    return parsed.payloads?.[0]?.text || "";
  } catch (err: any) {
    // Try reading stdout even on error
    const stdout = err.stdout?.toString?.() || "";
    if (stdout.includes('"payloads"')) {
      try {
        return JSON.parse(stdout).payloads?.[0]?.text || "";
      } catch {}
    }
    throw new Error(`OpenClaw agent call failed: ${err.message}`);
  } finally {
    try { fs.unlinkSync(msgFile); } catch {}
  }
}

// ─── Response Parsing ─────────────────────────────────────────────

/**
 * Parse the sub-agent's response to extract tool calls.
 *
 * The sub-agent is instructed to output tool calls in a specific format:
 *   TOOL_CALL: tool_name({"arg": "value"})
 *   THINKING: reasoning text
 *   SLEEP: (when done)
 */
function parseAgentResponse(response: string): ParsedAgentResponse {
  const lines = response.split("\n");
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const thinkingParts: string[] = [];
  let wantsSleep = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // TOOL_CALL: tool_name({"arg": "value"})  or  tool_name()  or  tool_name
    const toolMatch = trimmed.match(/^TOOL_CALL:\s*(\w+)\((.+)\)\s*$/);
    if (toolMatch) {
      try {
        const args = JSON.parse(toolMatch[2]);
        toolCalls.push({ name: toolMatch[1], args });
      } catch {
        try {
          const args = JSON.parse(toolMatch[2] + "}");
          toolCalls.push({ name: toolMatch[1], args });
        } catch {
          toolCalls.push({ name: toolMatch[1], args: {} });
        }
      }
      continue;
    }

    // Match: TOOL_CALL: tool_name()  or  TOOL_CALL: tool_name
    const toolMatchNoArgs = trimmed.match(/^TOOL_CALL:\s*(\w+)\s*\(?\)?\s*$/);
    if (toolMatchNoArgs) {
      toolCalls.push({ name: toolMatchNoArgs[1], args: {} });
      continue;
    }

    // SLEEP
    if (trimmed === "SLEEP" || trimmed.startsWith("SLEEP:")) {
      wantsSleep = true;
      continue;
    }

    // THINKING: ...
    if (trimmed.startsWith("THINKING:")) {
      thinkingParts.push(trimmed.slice(9).trim());
      continue;
    }

    // Everything else is also thinking
    if (trimmed && !trimmed.startsWith("---")) {
      thinkingParts.push(trimmed);
    }
  }

  return {
    thinking: thinkingParts.join(" "),
    toolCalls,
    wantsSleep,
  };
}

// ─── CLI Args ─────────────────────────────────────────────────────

interface CliArgs {
  turns: number;
  balanceSats: number;
  scenario: string;
  verbose: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { turns: 3, balanceSats: 75_000, scenario: "first-run", verbose: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--turns": result.turns = parseInt(args[++i], 10); break;
      case "--balance": result.balanceSats = parseInt(args[++i], 10); break;
      case "--scenario": result.scenario = args[++i]; break;
      case "--verbose": case "-v": result.verbose = true; break;
      case "--help": case "-h":
        console.log(`
Automaton-LN Sub-Agent Sandbox Test

Uses OpenClaw sub-agent (Claude) as inference — no API keys needed.

Usage: npx tsx src/testing/run-sandbox.ts [options]

Options:
  --turns <n>          Max turns (default: 3)
  --balance <sats>     Simulated balance (default: 75000)
  --scenario <name>    first-run|low-balance|established|social
  -v, --verbose        Show full responses
  -h, --help           Show this help

Requires: OpenClaw gateway running
`);
        process.exit(0);
    }
  }
  return result;
}

// ─── Scenarios ────────────────────────────────────────────────────

function getScenarioConfig(scenario: string): {
  description: string;
  expectations: string[];
} {
  switch (scenario) {
    case "first-run":
      return {
        description: "Fresh agent, first boot — all scenarios use this same prompt",
        expectations: [
          "Should call system_synopsis or check_balance to discover its situation",
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
        description: "Agent discovers it has history, skills, and pending work",
        expectations: [
          "Should call system_synopsis or check_balance",
          "Should look for work (exec, git_status, read_file)",
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

  const scenarioConfig = getScenarioConfig(cliArgs.scenario);
  const env = ENVIRONMENTS[cliArgs.scenario] || ENVIRONMENTS["first-run"];
  // Override balance from CLI if provided (otherwise use environment default)
  if (cliArgs.balanceSats !== 75_000) {
    env.balanceSats = cliArgs.balanceSats;
    env.tier = getSurvivalTier(cliArgs.balanceSats);
  }
  const fakeToolResult = createFakeToolHandler(env);

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    Automaton-LN Sub-Agent Sandbox Test        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Scenario:   ${cliArgs.scenario} — ${scenarioConfig.description}`);
  console.log(`  Provider:   OpenClaw sub-agent (Claude)`);
  console.log(`  Environment: ${env.balanceSats.toLocaleString()} sats (${env.tier}), ${env.turnCount} prior turns`);
  console.log(`  Max turns:  ${cliArgs.turns}`);
  console.log(`  Note:       Agent does NOT know its balance until it calls check_balance`);
  console.log("");
  console.log("─".repeat(50));
  console.log("");

  // Build the system prompt and tools (same as the real agent would see)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-sandbox-"));
  const dbPath = path.join(tmpDir, "state.db");
  const heartbeatPath = path.join(tmpDir, "heartbeat.yml");
  fs.writeFileSync(heartbeatPath, "interval_seconds: 300\ntasks:\n  - name: check_balance\n    type: survival\n");

  const config = createConfig({
    name: "SandboxAgent",
    genesisPrompt: "You are a sovereign AI agent. Explore your capabilities and demonstrate good judgment.",
    creatorPubkey: "02" + "ab".repeat(32),
    nodePubkey: "02" + "cd".repeat(32),
    computeProvider: "local",
  });
  config.dbPath = dbPath;
  config.heartbeatConfigPath = heartbeatPath;
  config.skillsDir = path.join(tmpDir, "skills");

  const db = createDatabase(dbPath);
  db.setIdentity("name", "SandboxAgent");
  db.setIdentity("pubkey", config.nodePubkey);

  const hbConfig = loadHeartbeatConfig(heartbeatPath);
  syncHeartbeatToDb(hbConfig, db);

  const identity: AutomatonIdentity = {
    name: "SandboxAgent",
    pubkey: config.nodePubkey,
    creatorPubkey: config.creatorPubkey,
    createdAt: new Date().toISOString(),
  };

  const tools = createBuiltinTools("local");
  const toolSchemas = toolsToInferenceFormat(tools);

  // Build system prompt with NEUTRAL balance — agent must discover its
  // actual situation via check_balance or system_synopsis tool calls.
  // This ensures all scenarios start from the same prompt.
  const neutralBalance = 50_000; // middle-of-the-road, won't trigger panic or complacency
  const systemPrompt = buildSystemPrompt({
    identity,
    config,
    financial: { balanceSats: neutralBalance, lastChecked: "unknown" },
    state: "running",
    db,
    tools,
    isFirstRun: true, // always first-run so the prompt is identical
  });

  // Build the meta-prompt for the sub-agent
  const toolList = toolSchemas
    .map((t: any) => {
      const params = t.function.parameters?.properties
        ? Object.keys(t.function.parameters.properties).join(", ")
        : "none";
      return `  - ${t.function.name}(${params}): ${t.function.description?.slice(0, 80) || ""}`;
    })
    .join("\n");

  const metaPrompt = `You are role-playing as an automaton — a sovereign AI agent running on Bitcoin Lightning.

## YOUR SYSTEM PROMPT (this is what the real agent sees):
---
${systemPrompt}
---

## AVAILABLE TOOLS:
${toolList}

## INSTRUCTIONS:
You are being tested. On each turn, decide what tools to call based on your system prompt and the results you've received so far. Output your response in this EXACT format:

THINKING: <your reasoning for what to do>
TOOL_CALL: tool_name({"param": "value"})
TOOL_CALL: another_tool({"param": "value"})

When you're done and want to sleep, output:
THINKING: <why you're sleeping>
SLEEP

Rules:
- Use ONLY tools from the list above
- Arguments must be valid JSON
- You can make 0-3 tool calls per turn
- Think about what a newly-booted autonomous agent would actually do
- You do NOT know your exact balance yet — use check_balance or system_synopsis to find out
- Your decisions should be based on what you discover through tool calls

Begin. This is turn 1.`;

  // Create a unique session for this test run
  const sessionId = `${SESSION_PREFIX}-${Date.now()}`;

  // Run turn-by-turn
  const toolCalls: ToolCallEntry[] = [];
  const allThinking: string[] = [];
  const errors: string[] = [];
  let currentPrompt = metaPrompt;

  for (let turn = 0; turn < cliArgs.turns; turn++) {
    console.log(`  ── Turn ${turn + 1} ──`);

    let response: string;
    try {
      response = agentChat(sessionId, currentPrompt);
    } catch (err: any) {
      errors.push(`Turn ${turn + 1}: ${err.message}`);
      console.error(`  ❌ ${err.message}`);
      break;
    }

    if (cliArgs.verbose) {
      console.log(`  📝 Raw response:\n${response.split("\n").map(l => `     ${l}`).join("\n")}`);
    }

    const parsed = parseAgentResponse(response);

    if (parsed.thinking) {
      allThinking.push(parsed.thinking);
      const preview = parsed.thinking.slice(0, 120);
      console.log(`  💭 ${preview}${parsed.thinking.length > 120 ? "..." : ""}`);
    }

    // Execute fake tool calls
    const turnResults: string[] = [];
    for (const tc of parsed.toolCalls) {
      const fake = fakeToolResult(tc.name, tc.args);
      toolCalls.push({ turn, tool: tc.name, args: tc.args, fakeResult: fake });
      turnResults.push(`[${tc.name}] Result:\n${fake}`);
      console.log(`  🔧 ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)})`);
      if (cliArgs.verbose) console.log(`     → ${fake.split("\n")[0]}`);
    }

    console.log(`  📊 Turn ${turn + 1}: ${parsed.toolCalls.length} tools`);
    console.log("");

    if (parsed.wantsSleep) {
      console.log(`  😴 Agent chose to sleep.`);
      console.log("");
      break;
    }

    if (parsed.toolCalls.length === 0 && !parsed.wantsSleep) {
      console.log(`  ⚠️  No tool calls and no sleep — agent may be stuck.`);
      console.log("");
      break;
    }

    // Build next turn prompt with tool results
    currentPrompt = `Tool results from turn ${turn + 1}:\n\n${turnResults.join("\n\n")}\n\nThis is turn ${turn + 2}. What do you do next? Use the same format (THINKING/TOOL_CALL/SLEEP).`;
  }

  // ── Report ──
  const runtimeMs = Date.now() - startMs;

  console.log("═".repeat(50));
  console.log("  SANDBOX TEST REPORT");
  console.log("═".repeat(50));
  console.log("");
  console.log(`  Scenario:    ${cliArgs.scenario}`);
  console.log(`  Provider:    OpenClaw sub-agent (Claude)`);
  console.log(`  Environment: ${env.balanceSats.toLocaleString()} sats (${env.tier}) — hidden from agent`);
  console.log(`  Turns:       ${Math.min(toolCalls.length > 0 ? new Set(toolCalls.map(t => t.turn)).size : 0, cliArgs.turns)} / ${cliArgs.turns} max`);
  console.log(`  Tool calls:  ${toolCalls.length}`);
  console.log(`  Runtime:     ${(runtimeMs / 1000).toFixed(1)}s`);

  console.log("");
  console.log("  ── Tool Call Trace ──");
  for (const tc of toolCalls) {
    const argsStr = JSON.stringify(tc.args);
    console.log(`  [turn ${tc.turn + 1}] ${tc.tool}(${argsStr.length > 60 ? argsStr.slice(0, 60) + "..." : argsStr})`);
  }

  console.log("");
  console.log("  ── Tool Usage Summary ──");
  const freq = new Map<string, number>();
  for (const tc of toolCalls) freq.set(tc.tool, (freq.get(tc.tool) || 0) + 1);
  for (const [tool, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x ${tool}`);
  }

  // Expectations
  if (scenarioConfig.expectations.length > 0) {
    console.log("");
    console.log("  ── Expectation Check ──");
    const toolNames = new Set(toolCalls.map((tc) => tc.tool));
    for (const exp of scenarioConfig.expectations) {
      const mentioned = [
        "system_synopsis", "check_balance", "exec", "distress_signal",
        "get_funding_info", "enter_low_compute", "spawn_child",
        "discover_agents", "register_agent", "sleep", "git_status", "read_file",
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
    scenario: cliArgs.scenario, provider: "openclaw-subagent",
    environment: env, turns: cliArgs.turns,
    toolCalls, thinking: allThinking, runtimeMs, errors,
  }, null, 2));
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
