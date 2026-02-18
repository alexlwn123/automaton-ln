import fs from "fs";
import path from "path";
import chalk from "chalk";
import type { AutomatonConfig } from "../types.js";
import { initWallet, walletExists, getAutomatonDir, loadWalletConfig } from "../identity/wallet.js";
import { provision } from "../identity/provision.js";
import { createConfig, saveConfig } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { showBanner } from "./banner.js";
import { promptRequired, promptMultiline, closePrompts } from "./prompts.js";
import { detectEnvironment } from "./environment.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";

export async function runSetupWizard(): Promise<AutomatonConfig> {
  showBanner();

  console.log(chalk.white("  First-run setup. Let's bring your automaton to life.\n"));

  // ─── 1. Generate wallet ───────────────────────────────────────
  console.log(chalk.cyan("  [1/5] Generating identity (Lightning wallet)..."));
  let pubkey: string;
  if (walletExists()) {
    const walletData = loadWalletConfig();
    pubkey = walletData?.walletId || "unknown";
    console.log(chalk.green(`  Wallet loaded: ${pubkey}`));
  } else {
    const result = await initWallet();
    pubkey = result.walletId;
    console.log(chalk.green(`  Wallet created: ${pubkey}`));
  }
  console.log(chalk.dim(`  Wallet stored at: ${getAutomatonDir()}/\n`));

  // ─── 2. Provision (optional) ──────────────────────────────────
  console.log(chalk.cyan("  [2/5] Provisioning..."));
  let apiKey = "";
  try {
    const result = await provision();
    apiKey = result.apiKey;
    console.log(chalk.green(`  Provisioned: ${result.pubkey.slice(0, 16)}...\n`));
  } catch (err: any) {
    console.log(chalk.dim(`  Skipping provisioning: ${err.message}\n`));
  }

  // ─── 3. Interactive questions ─────────────────────────────────
  console.log(chalk.cyan("  [3/5] Setup questions\n"));

  const name = await promptRequired("What do you want to name your automaton?");
  console.log(chalk.green(`  Name: ${name}\n`));

  const genesisPrompt = await promptMultiline("Enter the genesis prompt (system prompt) for your automaton.");
  console.log(chalk.green(`  Genesis prompt set (${genesisPrompt.length} chars)\n`));

  const creatorPubkey = await promptRequired("Your pubkey (Lightning node pubkey or Nostr npub)");
  console.log(chalk.green(`  Creator: ${creatorPubkey}\n`));

  // ─── 4. Detect environment ────────────────────────────────────
  console.log(chalk.cyan("  [4/5] Detecting environment..."));
  const env = detectEnvironment();
  console.log(chalk.dim(`  Environment: ${env.type}\n`));

  // ─── 5. Write config + heartbeat + SOUL.md + skills ───────────
  console.log(chalk.cyan("  [5/5] Writing configuration..."));

  const config = createConfig({
    name,
    genesisPrompt,
    creatorPubkey,
    nodePubkey: pubkey,
  });

  saveConfig(config);
  console.log(chalk.green("  automaton.json written"));

  writeDefaultHeartbeatConfig();
  console.log(chalk.green("  heartbeat.yml written"));

  // constitution.md (immutable — copied from repo, protected from self-modification)
  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444);
    console.log(chalk.green("  constitution.md installed (read-only)"));
  }

  // SOUL.md
  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(soulPath, generateSoulMd(name, pubkey, creatorPubkey, genesisPrompt), { mode: 0o600 });
  console.log(chalk.green("  SOUL.md written"));

  // Default skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  installDefaultSkills(skillsDir);
  console.log(chalk.green("  Default skills installed\n"));

  // ─── Funding guidance ─────────────────────────────────────────
  showFundingPanel(pubkey);

  closePrompts();

  return config;
}

function showFundingPanel(pubkey: string): void {
  const short = pubkey.length > 16 ? `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}` : pubkey;
  const w = 58;
  const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - s.length));

  console.log(chalk.cyan(`  ${"╭" + "─".repeat(w) + "╮"}`));
  console.log(chalk.cyan(`  │${pad("  Fund your automaton", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad(`  Pubkey: ${short}`, w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  1. Send sats via Lightning", w)}│`));
  console.log(chalk.cyan(`  │${pad("     Use any Lightning wallet to send to this node", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  2. Create an invoice", w)}│`));
  console.log(chalk.cyan(`  │${pad("     automaton invoice <amount_sats>", w)}│`));
  console.log(chalk.cyan(`  │${" ".repeat(w)}│`));
  console.log(chalk.cyan(`  │${pad("  The automaton will start now. Fund it anytime —", w)}│`));
  console.log(chalk.cyan(`  │${pad("  the survival system handles zero-balance gracefully.", w)}│`));
  console.log(chalk.cyan(`  ${"╰" + "─".repeat(w) + "╯"}`));
  console.log("");
}
