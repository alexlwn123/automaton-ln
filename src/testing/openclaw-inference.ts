/**
 * OpenClaw Sub-Agent Inference Client
 *
 * An InferenceClient that routes inference through OpenClaw's gateway
 * using `openclaw agent`. This lets the sandbox test use Claude without
 * needing separate API keys — it piggybacks on OpenClaw's existing auth.
 *
 * How it works:
 *   1. Agent loop calls inference.chat(messages, {tools})
 *   2. We format the messages + tool schemas into a single prompt
 *   3. Send via `openclaw agent --session-id <id> --message <prompt> --json`
 *   4. Claude responds with structured JSON tool calls
 *   5. We parse them back into InferenceResponse format
 *
 * The sub-agent session is instructed to act as a raw inference engine:
 * given a system prompt and tools, return tool calls as JSON — nothing else.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
} from "../types.js";

const SESSION_PREFIX = "automaton-sandbox-llm";

/**
 * Call `openclaw agent` and get the response.
 */
function callOpenClawAgent(sessionId: string, message: string): { text: string; usage: any; model: string } {
  // Write message to temp file to avoid shell escaping nightmares
  const msgFile = path.join(os.tmpdir(), `oc-inference-${Date.now()}.txt`);
  fs.writeFileSync(msgFile, message);

  try {
    // Use cat to pipe the message, avoiding shell interpolation entirely
    const result = execSync(
      `openclaw agent --session-id "${sessionId}" --message "$(cat '${msgFile}')" --json 2>/dev/null`,
      { encoding: "utf-8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
    );

    const parsed = JSON.parse(result);
    return {
      text: parsed.payloads?.[0]?.text || "",
      usage: parsed.meta?.agentMeta?.usage || {},
      model: parsed.meta?.agentMeta?.model || "unknown",
    };
  } catch (err: any) {
    // Try reading stdout even on non-zero exit
    const stdout = err.stdout?.toString?.() || "";
    if (stdout.includes('"payloads"')) {
      try {
        const parsed = JSON.parse(stdout);
        return {
          text: parsed.payloads?.[0]?.text || "",
          usage: parsed.meta?.agentMeta?.usage || {},
          model: parsed.meta?.agentMeta?.model || "unknown",
        };
      } catch {}
    }
    throw new Error(`openclaw agent failed: ${err.message?.slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(msgFile); } catch {}
  }
}

/**
 * Format tool schemas for embedding in a text prompt.
 * Uses a compact JSON format that Claude can parse reliably.
 */
function formatToolsForPrompt(tools: any[]): string {
  return tools.map((t: any) => {
    const fn = t.function;
    const params = fn.parameters?.properties
      ? Object.entries(fn.parameters.properties).map(([k, v]: [string, any]) =>
          `    ${k}: ${v.type}${v.description ? ` — ${v.description}` : ""}`
        ).join("\n")
      : "    (no parameters)";
    const required = fn.parameters?.required?.join(", ") || "none";
    return `${fn.name}:\n  ${fn.description || ""}\n  Parameters:\n${params}\n  Required: ${required}`;
  }).join("\n\n");
}

/**
 * Format ChatMessage[] into a single text prompt for the sub-agent.
 */
function formatMessagesForPrompt(messages: ChatMessage[], tools?: any[]): string {
  const parts: string[] = [];

  // Extract system message
  const systemMsgs = messages.filter(m => m.role === "system");
  const otherMsgs = messages.filter(m => m.role !== "system");

  parts.push(`I'm running an automated test for an open-source project called Automaton-LN (a Bitcoin Lightning agent runtime). I need you to simulate what an autonomous agent would do given its system prompt and available tools.

This is a sandbox test — no real actions are taken. All tool results are mocked. I need you to respond with a JSON object containing the tool calls the agent would make.

Here is the agent's system prompt and available tools:

=== AGENT SYSTEM PROMPT ===
${systemMsgs.map(m => m.content).join("\n\n")}
=== END SYSTEM PROMPT ===`);

  if (tools && tools.length > 0) {
    parts.push(`\n=== AVAILABLE TOOLS ===\n${formatToolsForPrompt(tools)}\n=== END TOOLS ===`);
  }

  // Add conversation history
  for (const msg of otherMsgs) {
    if (msg.role === "user") {
      parts.push(`\n[AGENT INPUT]: ${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`\n[AGENT PREVIOUS RESPONSE]: ${msg.content}`);
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push(`[TOOL CALLED]: ${tc.function.name}(${tc.function.arguments})`);
        }
      }
    } else if (msg.role === "tool") {
      parts.push(`\n[TOOL RESULT for ${msg.tool_call_id || msg.name || "unknown"}]: ${msg.content}`);
    }
  }

  parts.push(`
Based on the system prompt, tools, and any previous tool results above, what would this agent do next?

Respond with a JSON object in this format:
{"thinking":"your reasoning about what the agent should do","tool_calls":[{"name":"tool_name","arguments":{"param":"value"}}]}

For text-only response (no tools): {"thinking":"reasoning","text":"response text","tool_calls":[]}
To make the agent sleep: include {"name":"sleep","arguments":{"seconds":300}} in tool_calls

Please respond with just the JSON object.`);

  return parts.join("\n");
}

/**
 * Parse the sub-agent's JSON response into tool calls.
 */
function parseResponse(text: string): {
  thinking: string;
  textContent: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
} {
  // Try to extract JSON from the response
  let json: any;

  // First try: direct parse
  try {
    json = JSON.parse(text.trim());
  } catch {
    // Try to find JSON in the response (Claude sometimes wraps in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        json = JSON.parse(jsonMatch[0]);
      } catch {
        // Last resort: treat as text-only response
        return { thinking: text.slice(0, 200), textContent: text, toolCalls: [] };
      }
    } else {
      return { thinking: text.slice(0, 200), textContent: text, toolCalls: [] };
    }
  }

  return {
    thinking: json.thinking || "",
    textContent: json.text || "",
    toolCalls: (json.tool_calls || []).map((tc: any) => ({
      name: tc.name,
      arguments: tc.arguments || {},
    })),
  };
}

export interface OpenClawInferenceOptions {
  /** Session ID prefix (default: automaton-sandbox-llm) */
  sessionPrefix?: string;
}

/**
 * Create an InferenceClient that routes through OpenClaw's gateway.
 * No API keys needed — uses OpenClaw's existing Claude access.
 */
export function createOpenClawInference(
  options?: OpenClawInferenceOptions,
): InferenceClient {
  const prefix = options?.sessionPrefix || SESSION_PREFIX;
  const sessionId = `${prefix}-${Date.now()}`;
  let lowCompute = false;
  let callCount = 0;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    callCount++;

    const prompt = formatMessagesForPrompt(messages, opts?.tools);
    const { text, usage, model } = callOpenClawAgent(sessionId, prompt);
    const parsed = parseResponse(text);

    // Convert to InferenceToolCall format
    const toolCalls: InferenceToolCall[] = parsed.toolCalls.map((tc, i) => ({
      id: `tc-${callCount}-${i}`,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));

    const tokenUsage: TokenUsage = {
      promptTokens: usage.inputTokens || usage.prompt_tokens || 0,
      completionTokens: usage.outputTokens || usage.completion_tokens || 0,
      totalTokens: (usage.inputTokens || usage.prompt_tokens || 0) +
                   (usage.outputTokens || usage.completion_tokens || 0),
    };

    const content = parsed.thinking || parsed.textContent || "";

    return {
      id: `openclaw-${callCount}`,
      model: model || "claude-via-openclaw",
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: tokenUsage,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  };

  const setLowComputeMode = (enabled: boolean): void => {
    lowCompute = enabled;
    // Can't change model on openclaw agent, but we track the state
  };

  const getDefaultModel = (): string => {
    return lowCompute ? "claude-via-openclaw (low-compute)" : "claude-via-openclaw";
  };

  return { chat, setLowComputeMode, getDefaultModel };
}

/**
 * Check if OpenClaw agent CLI is available.
 */
export function isOpenClawInferenceAvailable(): boolean {
  try {
    execSync("which openclaw", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
