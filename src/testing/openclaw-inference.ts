/**
 * OpenClaw Inference Client
 *
 * An InferenceClient that uses the Anthropic API key from OpenClaw's
 * auth-profiles.json. This lets the sandbox test use the same Claude
 * access as OpenClaw without needing separate API keys.
 *
 * Talks to Anthropic's Messages API directly with proper tool schemas —
 * no text parsing, no regex, real structured tool calls.
 */

import fs from "fs";
import path from "path";
import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
} from "../types.js";

const AUTH_PROFILES_PATHS = [
  path.join(process.env.HOME || "/root", ".openclaw/agents/main/agent/auth-profiles.json"),
  path.join(process.env.HOME || "/root", ".openclaw/auth-profiles.json"),
];

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Load the Anthropic API key from OpenClaw's auth profiles.
 */
function loadAnthropicKey(): string | null {
  for (const p of AUTH_PROFILES_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      const profiles = data.profiles || {};

      // Look for any anthropic profile
      for (const [, profile] of Object.entries(profiles) as [string, any][]) {
        if (profile.provider === "anthropic" && profile.token) {
          return profile.token;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Convert OpenAI-format tool schemas to Anthropic format.
 */
function convertToolsToAnthropic(tools: any[]): any[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Convert our ChatMessage[] to Anthropic messages format.
 * Anthropic has separate system param, and tool results use a different format.
 */
function convertMessages(messages: ChatMessage[]): {
  system: string;
  anthropicMessages: any[];
} {
  let system = "";
  const anthropicMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system += (system ? "\n\n" : "") + msg.content;
      continue;
    }

    if (msg.role === "assistant") {
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = {};
          }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      anthropicMessages.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    // user message
    anthropicMessages.push({ role: "user", content: msg.content });
  }

  return { system, anthropicMessages };
}

export interface OpenClawInferenceOptions {
  /** Override model (default: claude-haiku-4-5-20241022 for cost) */
  model?: string;
  /** Max output tokens */
  maxTokens?: number;
  /** Low-compute model override */
  lowComputeModel?: string;
}

/**
 * Create an InferenceClient backed by the Anthropic API using
 * OpenClaw's stored credentials.
 *
 * Returns null if no Anthropic key is found.
 */
export function createOpenClawInference(
  options?: OpenClawInferenceOptions,
): InferenceClient | null {
  const apiKey = loadAnthropicKey();
  if (!apiKey) return null;

  const defaultModel = options?.model || "claude-haiku-4-5-20241022";
  const lowComputeModel = options?.lowComputeModel || "claude-haiku-4-5-20241022";
  let currentModel = defaultModel;
  let maxTokens = options?.maxTokens || 4096;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const { system, anthropicMessages } = convertMessages(messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: opts?.maxTokens || maxTokens,
      system,
      messages: anthropicMessages,
    };

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    // Convert and add tools
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = convertToolsToAnthropic(opts.tools);
      body.tool_choice = { type: "auto" };
    }

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // OAuth tokens (sk-ant-oat*) use Bearer auth; API keys use x-api-key
        ...(apiKey.startsWith("sk-ant-oat")
          ? { Authorization: `Bearer ${apiKey}` }
          : { "x-api-key": apiKey }),
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as any;

    // Parse Anthropic response format
    const contentBlocks: any[] = data.content || [];
    let textContent = "";
    const toolCalls: InferenceToolCall[] = [];

    for (const block of contentBlocks) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }

    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
      totalTokens:
        (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    };

    return {
      id: data.id || "",
      model: data.model || model,
      message: {
        role: "assistant",
        content: textContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason:
        data.stop_reason === "tool_use"
          ? "tool_calls"
          : data.stop_reason || "stop",
    };
  };

  const setLowComputeMode = (enabled: boolean): void => {
    currentModel = enabled ? lowComputeModel : defaultModel;
    if (enabled) maxTokens = 2048;
    else maxTokens = options?.maxTokens || 4096;
  };

  const getDefaultModel = (): string => currentModel;

  return { chat, setLowComputeMode, getDefaultModel };
}

/**
 * Check if OpenClaw inference is available (key exists).
 */
export function isOpenClawInferenceAvailable(): boolean {
  return loadAnthropicKey() !== null;
}
