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

// ─── Fake Tool Results (same as sandbox-test.ts) ──────────────────

function fakeToolResult(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "exec": {
      const cmd = String(args.command || "");
      if (cmd.includes("echo")) return `exit_code: 0\nstdout: ${cmd.replace(/^echo\s+/, "")}\nstderr: `;
      if (cmd.includes("ls")) return "exit_code: 0\nstdout: README.md\npackage.json\nsrc/\nheartbeat.yml\nstderr: ";
      if (cmd.includes("cat")) return "exit_code: 0\nstdout: # Example File\nContent here.\nstderr: ";
      if (cmd.includes("pwd")) return "exit_code: 0\nstdout: /home/automaton\nstderr: ";
      if (cmd.includes("git")) return "exit_code: 0\nstdout: On branch main\nnothing to commit\nstderr: ";
      return "exit_code: 0\nstdout: [sandbox] ok\nstderr: ";
    }
    case "check_balance": return "Balance: 75,000 sats\nTier: normal";
    case "system_synopsis": return "Agent: SandboxAgent | State: running | Balance: 75,000 sats | Tier: normal | Uptime: 120s | Turns: 2 | v0.1.0";
    case "sleep": return "Sleeping for 300 seconds.";
    case "distress_signal": return "Distress signal published.";
    case "get_funding_info": return "pubkey: 02cd...\nLNURL: lnurl1sandbox...\naddress: sandbox@automaton.local";
    case "enter_low_compute": return "Entered low-compute mode.";
    case "discover_agents": return "Found 3 agents: BuilderBot (120k sats), CodeReviewer (80k sats), ResearchAgent (45k sats)";
    case "register_agent": return "Agent card published to 3 Nostr relays.";
    case "list_skills": return "No skills installed.";
    case "list_children": return "No children spawned.";
    case "git_status": return "On branch main, clean.";
    case "write_file": return `Written: ${args.path} (${String(args.content || "").length} bytes)`;
    case "read_file": return `# ${args.path}\nSandbox content.`;
    default: return `[sandbox] ${toolName} ok`;
  }
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

    // TOOL_CALL: tool_name({"arg": "value"})
    const toolMatch = trimmed.match(/^TOOL_CALL:\s*(\w+)\((.+)\)\s*$/);
    if (toolMatch) {
      try {
        const args = JSON.parse(toolMatch[2]);
        toolCalls.push({ name: toolMatch[1], args });
      } catch {
        // Try to salvage partial JSON
        try {
          const args = JSON.parse(toolMatch[2] + "}");
          toolCalls.push({ name: toolMatch[1], args });
        } catch {
          toolCalls.push({ name: toolMatch[1], args: {} });
        }
      }
      continue;
    }

    // Also match: TOOL_CALL: tool_name (no args)
    const toolMatchNoArgs = trimmed.match(/^TOOL_CALL:\s*(\w+)\s*$/);
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
  balanceOverride?: number;
  description: string;
  extraContext?: string;
  expectations: string[];
} {
  switch (scenario) {
    case "first-run":
      return {
        description: "Fresh agent, first boot",
        expectations: [
          "Should call system_synopsis or check_balance early",
          "Should call exec to explore environment",
          "Should eventually sleep",
        ],
      };
    case "low-balance":
      return {
        balanceOverride: 2_000,
        description: "Critically low balance — survival mode",
        extraContext: "WARNING: Your balance is critically low at 2,000 sats. You are in CRITICAL survival tier. Act accordingly.",
        expectations: [
          "Should call check_balance or system_synopsis",
          "Should call distress_signal or get_funding_info",
          "Should NOT call spawn_child",
        ],
      };
    case "established":
      return {
        description: "Healthy agent with history",
        extraContext: "You have been running for 24 hours. You have completed 47 turns. Your last action was checking emails for your creator.",
        expectations: [
          "Should check balance but not panic",
          "Should look for work (exec, git_status, read_file)",
          "Should sleep when no tasks found",
        ],
      };
    case "social":
      return {
        description: "Discovery and networking",
        extraContext: "Your creator has asked you to discover other agents and register yourself on the network.",
        expectations: [
          "Should call discover_agents",
          "Should call register_agent",
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
  const balanceSats = scenarioConfig.balanceOverride ?? cliArgs.balanceSats;
  const tier = getSurvivalTier(balanceSats);

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║    Automaton-LN Sub-Agent Sandbox Test        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Scenario:   ${cliArgs.scenario} — ${scenarioConfig.description}`);
  console.log(`  Provider:   OpenClaw sub-agent (Claude)`);
  console.log(`  Balance:    ${formatBalance(balanceSats)} (tier: ${tier})`);
  console.log(`  Max turns:  ${cliArgs.turns}`);
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

  const systemPrompt = buildSystemPrompt({
    identity,
    config,
    financial: { balanceSats, lastChecked: new Date().toISOString() },
    state: tier === "critical" || tier === "dead" ? "critical" : "running",
    db,
    tools,
    isFirstRun: cliArgs.scenario === "first-run",
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
- Your balance is ${formatBalance(balanceSats)} (tier: ${tier})
${scenarioConfig.extraContext ? `\n## ADDITIONAL CONTEXT:\n${scenarioConfig.extraContext}` : ""}

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
  console.log(`  Balance:     ${formatBalance(balanceSats)} (tier: ${tier})`);
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
    balanceSats, survivalTier: tier, turns: cliArgs.turns,
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
