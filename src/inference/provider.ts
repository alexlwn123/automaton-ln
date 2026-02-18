/**
 * Inference Provider
 *
 * Wraps any OpenAI-compatible /v1/chat/completions endpoint.
 * Configurable: use OpenAI directly, Anthropic, local ollama, Conway, or L402 endpoints.
 * The automaton pays for its own thinking — however it needs to.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
} from "../types.js";

interface InferenceProviderOptions {
  apiUrl: string; // Any OpenAI-compatible endpoint
  apiKey?: string; // API key (undefined for local/L402)
  authMode?: "bearer" | "l402" | "none"; // How to authenticate
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
}

export function createInferenceProvider(
  options: InferenceProviderOptions,
): InferenceClient {
  const { apiUrl, apiKey, authMode = apiKey ? "bearer" : "none" } = options;
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    // Newer models require max_completion_tokens
    const usesCompletionTokens = /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // Build auth headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (authMode === "bearer" && apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    } else if (authMode === "l402") {
      // L402 flow: make request, if 402 → pay → retry
      // For now, just include the key if we have one
      if (apiKey) {
        headers.Authorization = apiKey;
      }
    }

    const resp = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Inference error: ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as any;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("No completion choice returned from inference");
    }

    const message = choice.message;
    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
    };

    const toolCalls: InferenceToolCall[] | undefined =
      message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    return {
      id: data.id || "",
      model: data.model || model,
      message: {
        role: message.role,
        content: message.content || "",
        tool_calls: toolCalls,
      },
      toolCalls,
      usage,
      finishReason: choice.finish_reason || "stop",
    };
  };

  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-4.1";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return { chat, setLowComputeMode, getDefaultModel };
}

function formatMessage(msg: ChatMessage): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}
