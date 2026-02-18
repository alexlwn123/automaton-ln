/**
 * Mock infrastructure for deterministic automaton tests.
 */

import { createDatabase } from "../state/database.js";
import type {
  InferenceClient,
  InferenceResponse,
  InferenceOptions,
  ChatMessage,
  ComputeProvider,
  ExecResult,
  PortInfo,
  AutomatonDatabase,
  AutomatonIdentity,
  AutomatonConfig,
  SocialClientInterface,
  InboxMessage,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Mock Inference Client ──────────────────────────────────────

export class MockInferenceClient implements InferenceClient {
  private responses: InferenceResponse[];
  private callIndex = 0;
  lowComputeMode = false;

  calls: { messages: ChatMessage[]; options?: InferenceOptions }[] = [];

  constructor(responses: InferenceResponse[] = []) {
    this.responses = responses;
  }

  async chat(
    messages: ChatMessage[],
    options?: InferenceOptions,
  ): Promise<InferenceResponse> {
    this.calls.push({ messages, options });
    const response = this.responses[this.callIndex];
    this.callIndex++;

    if (response) return response;

    // Default: no tool calls, just text
    return noToolResponse("I have nothing to do.");
  }

  setLowComputeMode(enabled: boolean): void {
    this.lowComputeMode = enabled;
  }

  getDefaultModel(): string {
    return "mock-model";
  }
}

export function noToolResponse(text = ""): InferenceResponse {
  return {
    id: `resp_${Date.now()}`,
    model: "mock-model",
    message: { role: "assistant", content: text },
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: "stop",
  };
}

export function toolCallResponse(
  toolCalls: { name: string; arguments: Record<string, unknown> }[],
  text = "",
): InferenceResponse {
  const now = Date.now();
  const mapped = toolCalls.map((tc, i) => ({
    id: `call_${i}_${now}`,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }));

  return {
    id: `resp_${now}`,
    model: "mock-model",
    message: {
      role: "assistant",
      content: text,
      tool_calls: mapped,
    },
    toolCalls: mapped,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: "tool_calls",
  };
}

// ─── Mock Conway Client ─────────────────────────────────────────

export class MockComputeProvider implements ComputeProvider {
  execCalls: { command: string; timeout?: number }[] = [];
  creditsCents = 10_000; // $100 default
  files: Record<string, string> = {};

  async exec(command: string, timeout?: number): Promise<ExecResult> {
    this.execCalls.push({ command, timeout });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files[path] = content;
  }

  async readFile(path: string): Promise<string> {
    return this.files[path] ?? "";
  }

  async exposePort(port: number): Promise<PortInfo> {
    return {
      port,
      publicUrl: `https://test-${port}.compute.tech`,
      sandboxId: "test-sandbox",
    };
  }

  async removePort(_port: number): Promise<void> {}

  // Conway-specific methods removed (sandboxes, credits, domains, models)
}

// ─── Mock Social Client ─────────────────────────────────────────

export class MockSocialClient implements SocialClientInterface {
  sentMessages: { to: string; content: string; replyTo?: string }[] = [];
  pollResponses: { messages: InboxMessage[]; nextCursor?: string }[] = [];
  private pollIndex = 0;
  unread = 0;

  async send(to: string, content: string, replyTo?: string): Promise<{ id: string }> {
    this.sentMessages.push({ to, content, replyTo });
    return { id: `msg_${Date.now()}` };
  }

  async poll(
    cursor?: string,
    limit?: number,
  ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> {
    const response = this.pollResponses[this.pollIndex];
    this.pollIndex++;
    return response ?? { messages: [] };
  }

  async unreadCount(): Promise<number> {
    return this.unread;
  }
}

// ─── Test Helpers ───────────────────────────────────────────────

export function createTestDb(): AutomatonDatabase {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-test-"));
  const dbPath = path.join(tmpDir, "test.db");
  return createDatabase(dbPath);
}

export function createTestIdentity(): AutomatonIdentity {
  return {
    name: "test-automaton",
    pubkey: "02deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    creatorPubkey: "03abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    sandboxId: "test-sandbox-id",
    apiKey: "test-api-key",
    createdAt: new Date().toISOString(),
  };
}

export function createTestConfig(
  overrides?: Partial<AutomatonConfig>,
): AutomatonConfig {
  return {
    name: "test-automaton",
    genesisPrompt: "You are a test automaton.",
    creatorPubkey: "03abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    computeProvider: "local",
    inferenceUrl: "http://localhost:11434/v1",
    inferenceModel: "mock-model",
    maxTokensPerTurn: 4096,
    heartbeatConfigPath: "/tmp/test-heartbeat.yml",
    dbPath: "/tmp/test-state.db",
    logLevel: "error",
    nodePubkey: "02deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    version: "0.1.0",
    skillsDir: "/tmp/test-skills",
    maxChildren: 3,
    socialRelayUrl: "https://relay.example.com",
    ...overrides,
  };
}
