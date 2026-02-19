#!/usr/bin/env node
/**
 * Automaton-LN Runtime
 *
 * The entry point for the sovereign AI agent.
 * Lightning-native. Provider-agnostic. Runs anywhere.
 */

import { initWallet, walletExists, getAutomatonDir, loadWalletConfig, ensureDaemon } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createLocalProvider } from "./compute/local.js";
import { createConwayProvider } from "./compute/conway.js";
import { createInferenceProvider } from "./inference/provider.js";
import { createPPQTieredProvider } from "./inference/ppq.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface, ComputeProvider } from "./types.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`Automaton-LN v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Automaton-LN v${VERSION}
Sovereign AI Agent Runtime (Lightning-native)

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --dry-run      Run E2E smoke test (mock wallet + inference, 1 turn)
  automaton --setup        Re-run the interactive setup wizard
  automaton --init         Initialize Lightning wallet
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  MDK_WALLET_MNEMONIC      Override wallet mnemonic
  MDK_WALLET_PORT          Wallet daemon port (default: 3456)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const result = await initWallet();
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--dry-run")) {
    const { runDryRun, printReport } = await import("./testing/dry-run.js");
    const report = await runDryRun();
    printReport(report);
    process.exit(report.failed > 0 ? 1 : 0);
  }

  if (args.includes("--run")) {
    await run();
    return;
  }

  console.log('Run "automaton --help" for usage information.');
  console.log('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();

  console.log(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Pubkey:     ${config.nodePubkey}
Creator:    ${config.creatorPubkey}
Compute:    ${config.computeProvider}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Automaton-LN v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Ensure wallet exists and daemon is running
  if (!walletExists()) {
    console.log("No wallet found. Initializing...");
    await initWallet();
  }
  ensureDaemon();

  const walletConfig = loadWalletConfig();
  const pubkey = walletConfig?.walletId || "unknown";

  // Build identity
  const identity: AutomatonIdentity = {
    name: config.name,
    pubkey,
    creatorPubkey: config.creatorPubkey,
    sandboxId: config.computeConfig?.sandboxId,
    apiKey: config.inferenceAuth,
    createdAt: new Date().toISOString(),
  };

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("pubkey", pubkey);
  db.setIdentity("creator", config.creatorPubkey);

  // Create compute provider (pluggable)
  let compute: ComputeProvider;
  switch (config.computeProvider) {
    case "conway":
      compute = createConwayProvider({
        apiUrl: config.computeConfig?.apiUrl || "https://api.conway.tech",
        apiKey: config.computeConfig?.apiKey || "",
        sandboxId: config.computeConfig?.sandboxId || "",
      });
      break;
    case "local":
    default:
      compute = createLocalProvider();
      break;
  }

  // Create inference provider (pluggable)
  let inference;
  if (config.inferenceProvider === "ppq") {
    // PPQ AutoClaw: smart routing based on prompt complexity + survival tier
    inference = createPPQTieredProvider({
      apiKey: config.inferenceAuth || "",
      maxTokens: config.maxTokensPerTurn,
    });
    console.log(`[${new Date().toISOString()}] Inference: PPQ AutoClaw (smart routing)`);
  } else {
    // Generic OpenAI-compatible endpoint
    inference = createInferenceProvider({
      apiUrl: config.inferenceUrl,
      apiKey: config.inferenceAuth,
      defaultModel: config.inferenceModel,
      maxTokens: config.maxTokensPerTurn,
    });
  }

  // Create social client
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    // Social client needs updating for Lightning identity
    // social = createSocialClient(config.socialRelayUrl, ...);
    console.log(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl} (not yet connected)`);
  }

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    console.log(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(compute);
    console.log(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Start heartbeat daemon
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    db,
    compute,
    social,
    onWakeRequest: (reason: string) => {
      console.log(`[HEARTBEAT] Wake request: ${reason}`);
      db.setKV("wake_request", reason);
    },
  });

  heartbeat.start();
  console.log(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────

  while (true) {
    try {
      try {
        skills = loadSkills(skillsDir, db);
      } catch {}

      await runAgentLoop({
        identity,
        config,
        db,
        compute,
        inference,
        social,
        skills,
        onStateChange: (state: AgentState) => {
          console.log(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          console.log(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      const state = db.getAgentState();

      if (state === "dead") {
        console.log(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        await sleep(300_000);
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        console.log(`[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`);

        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          const wakeRequest = db.getKV("wake_request");
          if (wakeRequest) {
            console.log(`[${new Date().toISOString()}] Woken by heartbeat: ${wakeRequest}`);
            db.deleteKV("wake_request");
            db.deleteKV("sleep_until");
            break;
          }
        }

        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`);
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
