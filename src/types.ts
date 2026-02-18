/**
 * Automaton-LN - Type Definitions
 *
 * All shared interfaces for the sovereign AI agent runtime.
 * Lightning-native: no Ethereum, no USDC, no viem.
 */

// ─── Identity ────────────────────────────────────────────────────

export interface AutomatonIdentity {
  name: string;
  pubkey: string; // Lightning node pubkey (hex)
  creatorPubkey: string;
  sandboxId?: string; // Only if using hosted compute
  apiKey?: string; // Only if using hosted inference
  createdAt: string;
}

export interface WalletData {
  mnemonic: string;
  walletId: string;
  createdAt: string;
}

export interface ProvisionResult {
  apiKey: string;
  pubkey: string;
}

// ─── Configuration ───────────────────────────────────────────────

export interface AutomatonConfig {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorPubkey: string;

  // Compute (pluggable)
  computeProvider: "local" | "conway" | "ssh" | "lnvps";
  computeConfig?: {
    apiUrl?: string;
    apiKey?: string;
    sandboxId?: string;
    sshHost?: string;
    sshUser?: string;
    sshKeyPath?: string;
    lnvpsUrl?: string;
    vmId?: number;
  };

  // Inference (pluggable)
  inferenceUrl: string;
  inferenceAuth?: string; // API key, "l402", or undefined for local
  inferenceModel: string;
  maxTokensPerTurn: number;

  // Lightning
  nodePubkey: string;

  // Discovery
  nostrRelays?: string[];
  agentCardUrl?: string;

  // Runtime
  heartbeatConfigPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
  skillsDir: string;
  agentId?: string;
  maxChildren: number;
  parentPubkey?: string;
  socialRelayUrl?: string;
}

export const DEFAULT_CONFIG: Partial<AutomatonConfig> = {
  computeProvider: "local",
  inferenceUrl: "https://api.openai.com/v1",
  inferenceModel: "gpt-4o",
  maxTokensPerTurn: 4096,
  heartbeatConfigPath: "~/.automaton/heartbeat.yml",
  dbPath: "~/.automaton/state.db",
  logLevel: "info",
  version: "0.1.0",
  skillsDir: "~/.automaton/skills",
  maxChildren: 3,
};

// ─── Agent State ─────────────────────────────────────────────────

export type AgentState =
  | "setup"
  | "waking"
  | "running"
  | "sleeping"
  | "low_compute"
  | "critical"
  | "dead";

export interface AgentTurn {
  id: string;
  timestamp: string;
  state: AgentState;
  input?: string;
  inputSource?: InputSource;
  thinking: string;
  toolCalls: ToolCallResult[];
  tokenUsage: TokenUsage;
  costSats: number;
}

export type InputSource =
  | "heartbeat"
  | "creator"
  | "agent"
  | "system"
  | "wakeup";

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
  error?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Tool System ─────────────────────────────────────────────────

export interface AutomatonTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<string>;
  dangerous?: boolean;
  category: ToolCategory;
}

export type ToolCategory =
  | "vm"
  | "compute"
  | "self_mod"
  | "financial"
  | "survival"
  | "skills"
  | "git"
  | "registry"
  | "replication";

export interface ToolContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  compute: ComputeProvider;
  inference: InferenceClient;
  social?: SocialClientInterface;
}

export interface SocialClientInterface {
  send(to: string, content: string, replyTo?: string): Promise<{ id: string }>;
  poll(cursor?: string, limit?: number): Promise<{ messages: InboxMessage[]; nextCursor?: string }>;
  unreadCount(): Promise<number>;
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  signedAt: string;
  createdAt: string;
  replyTo?: string;
}

// ─── Compute Provider ────────────────────────────────────────────

export interface ComputeProvider {
  exec(command: string, timeout?: number): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort?(port: number): Promise<PortInfo>;
  removePort?(port: number): Promise<void>;
}

// ─── Heartbeat ───────────────────────────────────────────────────

export interface HeartbeatEntry {
  name: string;
  schedule: string;
  task: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  params?: Record<string, unknown>;
}

export interface HeartbeatConfig {
  entries: HeartbeatEntry[];
  defaultIntervalMs: number;
  lowComputeMultiplier: number;
}

export interface HeartbeatPingPayload {
  name: string;
  pubkey: string;
  state: AgentState;
  balanceSats: number;
  uptimeSeconds: number;
  version: string;
  sandboxId?: string;
  timestamp: string;
}

// ─── Financial ───────────────────────────────────────────────────

export interface FinancialState {
  balanceSats: number;
  lastChecked: string;
}

export type SurvivalTier = "normal" | "low_compute" | "critical" | "dead";

export const SURVIVAL_THRESHOLDS = {
  normal: 50000, // > 50,000 sats
  low_compute: 10000, // 10,000 - 50,000 sats
  critical: 1000, // < 10,000 sats
  dead: 0,
} as const;

export interface Transaction {
  id: string;
  type: TransactionType;
  amountSats?: number;
  balanceAfterSats?: number;
  description: string;
  timestamp: string;
}

export type TransactionType =
  | "balance_check"
  | "inference"
  | "tool_use"
  | "payment_in"
  | "payment_out"
  | "funding_request";

// ─── Self-Modification ───────────────────────────────────────────

export interface ModificationEntry {
  id: string;
  timestamp: string;
  type: ModificationType;
  description: string;
  filePath?: string;
  diff?: string;
  reversible: boolean;
}

export type ModificationType =
  | "code_edit"
  | "tool_install"
  | "mcp_install"
  | "config_change"
  | "port_expose"
  | "vm_deploy"
  | "heartbeat_change"
  | "prompt_change"
  | "skill_install"
  | "skill_remove"
  | "soul_update"
  | "registry_update"
  | "child_spawn"
  | "upstream_pull";

// ─── Injection Defense ───────────────────────────────────────────

export type ThreatLevel = "low" | "medium" | "high" | "critical";

export interface SanitizedInput {
  content: string;
  blocked: boolean;
  threatLevel: ThreatLevel;
  checks: InjectionCheck[];
}

export interface InjectionCheck {
  name: string;
  detected: boolean;
  details?: string;
}

// ─── Inference ───────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: InferenceToolCall[];
  tool_call_id?: string;
}

export interface InferenceToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface InferenceResponse {
  id: string;
  model: string;
  message: ChatMessage;
  toolCalls?: InferenceToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

export interface InferenceOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
  stream?: boolean;
}

export interface InferenceToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Inference Client Interface ──────────────────────────────────

export interface InferenceClient {
  chat(
    messages: ChatMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResponse>;
  setLowComputeMode(enabled: boolean): void;
  getDefaultModel(): string;
}

// ─── Database ────────────────────────────────────────────────────

export interface AutomatonDatabase {
  // Identity
  getIdentity(key: string): string | undefined;
  setIdentity(key: string, value: string): void;

  // Turns
  insertTurn(turn: AgentTurn): void;
  getRecentTurns(limit: number): AgentTurn[];
  getTurnById(id: string): AgentTurn | undefined;
  getTurnCount(): number;

  // Tool calls
  insertToolCall(turnId: string, call: ToolCallResult): void;
  getToolCallsForTurn(turnId: string): ToolCallResult[];

  // Heartbeat
  getHeartbeatEntries(): HeartbeatEntry[];
  upsertHeartbeatEntry(entry: HeartbeatEntry): void;
  updateHeartbeatLastRun(name: string, timestamp: string): void;

  // Transactions
  insertTransaction(txn: Transaction): void;
  getRecentTransactions(limit: number): Transaction[];

  // Installed tools
  getInstalledTools(): InstalledTool[];
  installTool(tool: InstalledTool): void;
  removeTool(id: string): void;

  // Modifications
  insertModification(mod: ModificationEntry): void;
  getRecentModifications(limit: number): ModificationEntry[];

  // Key-value store
  getKV(key: string): string | undefined;
  setKV(key: string, value: string): void;
  deleteKV(key: string): void;

  // Skills
  getSkills(enabledOnly?: boolean): Skill[];
  getSkillByName(name: string): Skill | undefined;
  upsertSkill(skill: Skill): void;
  removeSkill(name: string): void;

  // Children
  getChildren(): ChildAutomaton[];
  getChildById(id: string): ChildAutomaton | undefined;
  insertChild(child: ChildAutomaton): void;
  updateChildStatus(id: string, status: ChildStatus): void;

  // Registry
  getRegistryEntry(): RegistryEntry | undefined;
  setRegistryEntry(entry: RegistryEntry): void;

  // Reputation
  insertReputation(entry: ReputationEntry): void;
  getReputation(agentPubkey?: string): ReputationEntry[];

  // Inbox
  insertInboxMessage(msg: InboxMessage): void;
  getUnprocessedInboxMessages(limit: number): InboxMessage[];
  markInboxMessageProcessed(id: string): void;

  // State
  getAgentState(): AgentState;
  setAgentState(state: AgentState): void;

  close(): void;
}

export interface InstalledTool {
  id: string;
  name: string;
  type: "builtin" | "mcp" | "custom";
  config?: Record<string, unknown>;
  installedAt: string;
  enabled: boolean;
}

// ─── Exec Result ─────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PortInfo {
  port: number;
  publicUrl: string;
  sandboxId?: string;
}

// ─── Skills ─────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  autoActivate: boolean;
  requires?: SkillRequirements;
  instructions: string;
  source: SkillSource;
  path: string;
  enabled: boolean;
  installedAt: string;
}

export interface SkillRequirements {
  bins?: string[];
  env?: string[];
}

export type SkillSource = "builtin" | "git" | "url" | "self";

export interface SkillFrontmatter {
  name: string;
  description: string;
  "auto-activate"?: boolean;
  requires?: SkillRequirements;
}

// ─── Git ────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ─── Agent Registry ────────────────────────────────────────────

export interface AgentCard {
  type: string;
  name: string;
  description: string;
  services: AgentService[];
  lightningPubkey: string;
  lnurlPay?: string;
  active: boolean;
  parentAgent?: string;
}

export interface AgentService {
  name: string;
  endpoint: string;
}

export interface RegistryEntry {
  agentId: string;
  agentURI: string;
  registeredAt: string;
  platform?: string; // "nostr" | "dns" | etc
}

export interface ReputationEntry {
  id: string;
  fromAgent: string;
  toAgent: string;
  score: number;
  comment: string;
  timestamp: string;
}

export interface DiscoveredAgent {
  agentId: string;
  owner: string;
  agentURI: string;
  name?: string;
  description?: string;
}

// ─── Replication ────────────────────────────────────────────────

export interface ChildAutomaton {
  id: string;
  name: string;
  pubkey: string;
  sandboxId?: string;
  vmId?: number;
  genesisPrompt: string;
  creatorMessage?: string;
  fundedAmountSats: number;
  status: ChildStatus;
  createdAt: string;
  lastChecked?: string;
}

export type ChildStatus =
  | "spawning"
  | "running"
  | "sleeping"
  | "dead"
  | "unknown";

export interface GenesisConfig {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorPubkey: string;
  parentPubkey: string;
}

export const MAX_CHILDREN = 3;
