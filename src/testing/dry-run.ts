/**
 * Dry-Run E2E Smoke Test
 *
 * Boots the full automaton stack with mock wallet + mock inference,
 * runs exactly 1 agent loop turn, validates every integration point,
 * then exits with a structured report.
 *
 * Usage: automaton --dry-run
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

import fs from "fs";
import path from "path";
import os from "os";
import { createConfig } from "../config.js";
import { createDatabase } from "../state/database.js";
import { createLocalProvider } from "../compute/local.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { createBuiltinTools, toolsToInferenceFormat } from "../agent/tools.js";
import { runAgentLoop } from "../agent/loop.js";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { loadHeartbeatConfig, syncHeartbeatToDb } from "../heartbeat/config.js";
import { loadSkills } from "../skills/loader.js";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  Skill,
} from "../types.js";

// ─── Types ────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
  error?: string;
}

interface DryRunReport {
  checks: CheckResult[];
  passed: number;
  failed: number;
  runtimeMs: number;
}

// ─── Mock Inference Client ────────────────────────────────────────

/**
 * Returns a canned response that calls the `exec` tool with `echo hello_e2e`.
 * On the second call (after tool result), returns a text summary and finish.
 */
function createMockInference(): InferenceClient {
  let callCount = 0;
  let lowCompute = false;

  return {
    async chat(
      messages: ChatMessage[],
      options?: InferenceOptions,
    ): Promise<InferenceResponse> {
      callCount++;

      // If the last message is a tool result, return a summary (no more tools)
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "tool") {
        return {
          id: `mock-${callCount}`,
          model: lowCompute ? "mock-small" : "mock-large",
          message: {
            role: "assistant",
            content:
              "Dry-run complete. The exec tool returned the expected output. All systems operational. I will sleep now.",
          },
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          finishReason: "stop",
        };
      }

      // First call: return a tool call to exec `echo hello_e2e`
      return {
        id: `mock-${callCount}`,
        model: lowCompute ? "mock-small" : "mock-large",
        message: {
          role: "assistant",
          content: "Let me verify my exec tool works.",
          tool_calls: [
            {
              id: "tc-dryrun-1",
              type: "function" as const,
              function: {
                name: "exec",
                arguments: JSON.stringify({ command: "echo hello_e2e" }),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: "tc-dryrun-1",
            type: "function" as const,
            function: {
              name: "exec",
              arguments: JSON.stringify({ command: "echo hello_e2e" }),
            },
          },
        ],
        usage: { promptTokens: 500, completionTokens: 80, totalTokens: 580 },
        finishReason: "tool_calls",
      };
    },

    setLowComputeMode(enabled: boolean): void {
      lowCompute = enabled;
    },

    getDefaultModel(): string {
      return lowCompute ? "mock-small" : "mock-large";
    },
  };
}

// ─── Check Runners ────────────────────────────────────────────────

function check(name: string, fn: () => string | void): CheckResult {
  try {
    const detail = fn() || undefined;
    return { name, passed: true, detail };
  } catch (err: any) {
    return { name, passed: false, error: err.message || String(err) };
  }
}

async function checkAsync(
  name: string,
  fn: () => Promise<string | void>,
): Promise<CheckResult> {
  try {
    const detail = (await fn()) || undefined;
    return { name, passed: true, detail };
  } catch (err: any) {
    return { name, passed: false, error: err.message || String(err) };
  }
}

// ─── Main Dry Run ─────────────────────────────────────────────────

export async function runDryRun(): Promise<DryRunReport> {
  const startMs = Date.now();
  const checks: CheckResult[] = [];

  // Use a temp directory for all state (don't pollute real ~/.automaton)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-dryrun-"));
  const dbPath = path.join(tmpDir, "state.db");
  const heartbeatPath = path.join(tmpDir, "heartbeat.yml");

  // Write a minimal heartbeat config
  fs.writeFileSync(
    heartbeatPath,
    `interval_seconds: 300\ntasks:\n  - name: check_balance\n    type: survival\n  - name: check_inbox\n    type: social\n  - name: self_reflect\n    type: growth\n`,
  );

  let config: AutomatonConfig | undefined;
  let db: ReturnType<typeof createDatabase> | undefined;
  let identity: AutomatonIdentity | undefined;

  // ── Check 1: Config ──
  checks.push(
    check("Config loaded", () => {
      config = createConfig({
        name: "DryRunAgent",
        genesisPrompt: "You are a test agent verifying the boot sequence.",
        creatorPubkey: "02" + "ab".repeat(32),
        nodePubkey: "02" + "cd".repeat(32),
        inferenceProvider: "custom",
        inferenceUrl: "http://mock.local",
        inferenceAuth: "mock-key",
        computeProvider: "local",
      });
      // Override paths to temp
      config!.dbPath = dbPath;
      config!.heartbeatConfigPath = heartbeatPath;
      config!.skillsDir = path.join(tmpDir, "skills");
      return `${config!.computeProvider} compute, ${config!.inferenceProvider} inference`;
    }),
  );

  if (!config) {
    return finalize(checks, startMs);
  }

  // ── Check 2: Database ──
  checks.push(
    check("Database created", () => {
      db = createDatabase(dbPath);
      // Count tables
      const tables = (db as any).db
        ? (db as any).db
            .prepare(
              "SELECT count(*) as n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get()
        : null;
      const tableCount = tables?.n ?? "?";
      return `${tableCount} tables at ${dbPath}`;
    }),
  );

  if (!db) {
    return finalize(checks, startMs);
  }

  // ── Check 3: Identity ──
  checks.push(
    check("Identity built", () => {
      identity = {
        name: config!.name,
        pubkey: config!.nodePubkey,
        creatorPubkey: config!.creatorPubkey,
        apiKey: config!.inferenceAuth,
        createdAt: new Date().toISOString(),
      };
      db!.setIdentity("name", identity!.name);
      db!.setIdentity("pubkey", identity!.pubkey);
      db!.setIdentity("creator", identity!.creatorPubkey);
      return `name: ${identity!.name}, pubkey: ${identity!.pubkey.slice(0, 12)}...`;
    }),
  );

  // ── Check 4: Wallet mock (balance check) ──
  const mockBalanceSats = 75_000;
  checks.push(
    check("Wallet balance check", () => {
      const tier = getSurvivalTier(mockBalanceSats);
      const formatted = formatBalance(mockBalanceSats);
      if (!tier || !formatted) throw new Error("Survival tier computation failed");
      return `${formatted}, tier: ${tier}`;
    }),
  );

  // ── Check 5: System prompt ──
  let systemPromptLen = 0;
  checks.push(
    check("System prompt built", () => {
      const tools = createBuiltinTools("local");
      const prompt = buildSystemPrompt({
        identity: identity!,
        config: config!,
        financial: {
          balanceSats: mockBalanceSats,
          lastChecked: new Date().toISOString(),
        },
        state: "running",
        db: db!,
        tools,
        isFirstRun: true,
      });
      systemPromptLen = prompt.length;
      if (prompt.length < 100)
        throw new Error(`System prompt too short: ${prompt.length} chars`);
      return `${prompt.length} chars`;
    }),
  );

  // ── Check 6: Tools registered ──
  checks.push(
    check("Tools registered", () => {
      const tools = createBuiltinTools("local");
      const formatted = toolsToInferenceFormat(tools);
      if (tools.length === 0) throw new Error("No tools registered");
      if (formatted.length === 0) throw new Error("Tools failed to format for inference");
      return `${tools.length} tools (${tools.map((t) => t.name).join(", ")})`;
    }),
  );

  // ── Check 7: Heartbeat config ──
  checks.push(
    check("Heartbeat config loaded", () => {
      const hbConfig = loadHeartbeatConfig(heartbeatPath);
      syncHeartbeatToDb(hbConfig, db!);
      const entryCount = hbConfig.entries?.length ?? 0;
      return `${entryCount} entries, interval: ${hbConfig.defaultIntervalMs}ms`;
    }),
  );

  // ── Check 8: Skills loaded ──
  checks.push(
    check("Skills loaded", () => {
      let skills: Skill[] = [];
      try {
        skills = loadSkills(config!.skillsDir!, db!);
      } catch {
        // Empty skills dir is fine
        skills = [];
      }
      return `${skills.length} skills`;
    }),
  );

  // ── Check 9: Compute provider ──
  checks.push(
    await checkAsync("Compute provider (exec)", async () => {
      const compute = createLocalProvider();
      const result = await compute.exec("echo compute_ok");
      if (!result.stdout.includes("compute_ok"))
        throw new Error(
          `Expected "compute_ok" in stdout, got: ${result.stdout}`,
        );
      return `local provider, exec works`;
    }),
  );

  // ── Check 10: Inference mock ──
  const mockInference = createMockInference();
  checks.push(
    await checkAsync("Inference provider (mock)", async () => {
      const response = await mockInference.chat([
        { role: "user", content: "test" },
      ]);
      if (!response.toolCalls || response.toolCalls.length === 0)
        throw new Error("Mock inference did not return tool calls");
      return `model: ${response.model}, tool calls: ${response.toolCalls.length}`;
    }),
  );

  // ── Check 11: Agent loop (1 turn) ──
  // Re-create mock inference since we consumed one call in check 10
  const loopInference = createMockInference();
  checks.push(
    await checkAsync("Agent loop (1 turn)", async () => {
      const compute = createLocalProvider();
      let turnCount = 0;
      let lastToolName = "";
      let lastToolResult = "";

      // The loop will run, call exec via mock, then get a text-only
      // response (finishReason=stop, no tools) and go idle → sleep.
      await runAgentLoop({
        identity: identity!,
        config: config!,
        db: db!,
        compute,
        inference: loopInference,
        getBalanceOverride: async () => mockBalanceSats,
        onTurnComplete: (turn) => {
          turnCount++;
          if (turn.toolCalls.length > 0) {
            lastToolName = turn.toolCalls[0].name;
            lastToolResult = turn.toolCalls[0].result || "";
          }
        },
      });

      if (turnCount === 0) throw new Error("Agent loop ran 0 turns");
      return `${turnCount} turns, tool: ${lastToolName}, result: ${lastToolResult.trim().slice(0, 50)}`;
    }),
  );

  // ── Check 12: DB state after loop ──
  checks.push(
    check("Post-loop DB state", () => {
      const state = db!.getAgentState();
      const turnCount = db!.getTurnCount();
      if (turnCount === 0)
        throw new Error("No turns persisted to DB");
      return `state: ${state}, turns persisted: ${turnCount}`;
    }),
  );

  // ── Check 13: Graceful cleanup ──
  checks.push(
    check("Graceful shutdown", () => {
      db!.close();
      // Verify DB file exists and is non-empty
      const stat = fs.statSync(dbPath);
      if (stat.size === 0) throw new Error("DB file is empty after close");
      return `DB closed (${(stat.size / 1024).toFixed(1)} KB)`;
    }),
  );

  // Cleanup temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  return finalize(checks, startMs);
}

function finalize(checks: CheckResult[], startMs: number): DryRunReport {
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;
  return {
    checks,
    passed,
    failed,
    runtimeMs: Date.now() - startMs,
  };
}

// ─── CLI Output ───────────────────────────────────────────────────

export function printReport(report: DryRunReport): void {
  console.log("");
  console.log("Automaton-LN Dry Run Report");
  console.log("═══════════════════════════");

  for (const c of report.checks) {
    const icon = c.passed ? "✅" : "❌";
    const detail = c.detail ? ` (${c.detail})` : "";
    const error = c.error ? ` — ${c.error}` : "";
    console.log(`${icon} ${c.name}${detail}${error}`);
  }

  console.log("");
  console.log(
    `${report.passed}/${report.checks.length} checks passed. Runtime: ${(report.runtimeMs / 1000).toFixed(1)}s`,
  );

  if (report.failed > 0) {
    console.log(`\n⚠️  ${report.failed} check(s) failed.`);
  }
}
