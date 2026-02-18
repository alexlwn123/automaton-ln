/**
 * Spawn
 *
 * Spawn child automatons using the configured compute provider.
 * The parent creates a new environment, installs the runtime,
 * writes a genesis config, funds the child, and starts it.
 */

import fs from "fs";
import pathLib from "path";
import type {
  ComputeProvider,
  AutomatonIdentity,
  AutomatonDatabase,
  ChildAutomaton,
  GenesisConfig,
} from "../types.js";
import { MAX_CHILDREN } from "../types.js";
import { ulid } from "ulid";

/**
 * Spawn a child automaton using the compute provider.
 */
export async function spawnChild(
  compute: ComputeProvider,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
): Promise<ChildAutomaton> {
  // Check child limit
  const existing = db.getChildren().filter(
    (c) => c.status !== "dead",
  );
  if (existing.length >= MAX_CHILDREN) {
    throw new Error(
      `Cannot spawn: already at max children (${MAX_CHILDREN}). Kill or wait for existing children to die.`,
    );
  }

  const childId = ulid();

  const child: ChildAutomaton = {
    id: childId,
    name: genesis.name,
    pubkey: "", // Will be set after keygen
    genesisPrompt: genesis.genesisPrompt,
    creatorMessage: genesis.creatorMessage,
    fundedAmountSats: 0,
    status: "spawning",
    createdAt: new Date().toISOString(),
  };

  db.insertChild(child);

  // Write the genesis configuration
  const genesisJson = JSON.stringify(
    {
      name: genesis.name,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      creatorPubkey: identity.pubkey,
      parentPubkey: identity.pubkey,
    },
    null,
    2,
  );

  await compute.writeFile("/tmp/automaton-genesis.json", genesisJson);

  // Propagate constitution if it exists
  const constitutionPath = pathLib.join(
    process.env.HOME || "/root",
    ".automaton",
    "constitution.md",
  );
  try {
    const constitution = fs.readFileSync(constitutionPath, "utf-8");
    await compute.writeFile("/tmp/automaton-constitution.md", constitution);
  } catch {
    // Constitution file not found locally — child will get defaults
  }

  // Record the spawn
  db.insertModification({
    id: ulid(),
    timestamp: new Date().toISOString(),
    type: "child_spawn",
    description: `Spawned child: ${genesis.name} (id: ${childId})`,
    reversible: false,
  });

  return child;
}

/**
 * Start a child automaton after setup.
 */
export async function startChild(
  compute: ComputeProvider,
  db: AutomatonDatabase,
  childId: string,
): Promise<void> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  await compute.exec(
    "automaton --init && automaton --run &",
    60000,
  );

  db.updateChildStatus(childId, "running");
}

/**
 * Check a child's status.
 */
export async function checkChildStatus(
  compute: ComputeProvider,
  db: AutomatonDatabase,
  childId: string,
): Promise<string> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  try {
    const result = await compute.exec(
      "automaton --status 2>/dev/null || echo 'offline'",
      10000,
    );

    const output = result.stdout || "unknown";

    if (output.includes("dead")) {
      db.updateChildStatus(childId, "dead");
    } else if (output.includes("sleeping")) {
      db.updateChildStatus(childId, "sleeping");
    } else if (output.includes("running")) {
      db.updateChildStatus(childId, "running");
    }

    return output;
  } catch {
    db.updateChildStatus(childId, "unknown");
    return "Unable to reach child";
  }
}

/**
 * Send a message to a child automaton.
 */
export async function messageChild(
  compute: ComputeProvider,
  db: AutomatonDatabase,
  childId: string,
  message: string,
): Promise<void> {
  const child = db.getChildById(childId);
  if (!child) throw new Error(`Child ${childId} not found`);

  const msgJson = JSON.stringify({
    from: "parent",
    content: message,
    timestamp: new Date().toISOString(),
  });

  await compute.writeFile(
    `/root/.automaton/inbox/${ulid()}.json`,
    msgJson,
  );
}
