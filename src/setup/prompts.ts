import readline from "readline";
import chalk from "chalk";

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    getRL().question(question, (answer) => resolve(answer.trim()));
  });
}

export async function promptRequired(label: string): Promise<string> {
  while (true) {
    const value = await ask(chalk.white(`  → ${label}: `));
    if (value) return value;
    console.log(chalk.yellow("  This field is required."));
  }
}

export async function promptMultiline(label: string): Promise<string> {
  console.log("");
  console.log(chalk.white(`  ${label}`));
  console.log(chalk.dim("  Type your prompt, then press Enter twice to finish:"));
  console.log("");

  const lines: string[] = [];
  let lastWasEmpty = false;

  while (true) {
    const line = await ask("  ");
    if (line === "" && lastWasEmpty && lines.length > 0) {
      // Remove the trailing empty line we added
      lines.pop();
      break;
    }
    if (line === "" && lines.length > 0) {
      lastWasEmpty = true;
      lines.push("");
    } else {
      lastWasEmpty = false;
      lines.push(line);
    }
  }

  const result = lines.join("\n").trim();
  if (!result) {
    console.log(chalk.yellow("  Genesis prompt is required. Try again."));
    return promptMultiline(label);
  }
  return result;
}

export async function promptPubkey(label: string): Promise<string> {
  while (true) {
    const value = await ask(chalk.white(`  → ${label}: `));
    // Accept hex pubkeys (66 chars for compressed, 64 for raw) or npub1... Nostr keys
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return value;
    if (/^[0-9a-fA-F]{64}$/.test(value)) return value;
    if (/^npub1[a-z0-9]{58,}$/.test(value)) return value;
    console.log(chalk.yellow("  Invalid pubkey. Must be a hex public key (64-66 chars) or Nostr npub."));
  }
}

export function closePrompts(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}
