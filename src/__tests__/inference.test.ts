/**
 * Inference Provider Tests
 *
 * Tests provider creation, model switching, message formatting,
 * and PPQ integration — all without making real API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createInferenceProvider } from "../inference/provider.js";
import { createPPQProvider, createPPQTieredProvider, PPQ_API_URL } from "../inference/ppq.js";

describe("Inference Provider", () => {
  describe("createInferenceProvider", () => {
    it("creates a provider with the given default model", () => {
      const provider = createInferenceProvider({
        apiUrl: "http://localhost:11434/v1",
        defaultModel: "llama3",
        maxTokens: 2048,
      });
      expect(provider.getDefaultModel()).toBe("llama3");
    });

    it("switches to low compute model", () => {
      const provider = createInferenceProvider({
        apiUrl: "http://localhost:11434/v1",
        defaultModel: "claude-sonnet-4-6",
        maxTokens: 4096,
        lowComputeModel: "gpt-4o-mini",
      });
      expect(provider.getDefaultModel()).toBe("claude-sonnet-4-6");

      provider.setLowComputeMode(true);
      expect(provider.getDefaultModel()).toBe("gpt-4o-mini");

      provider.setLowComputeMode(false);
      expect(provider.getDefaultModel()).toBe("claude-sonnet-4-6");
    });

    it("defaults to gpt-4.1 when no lowComputeModel specified", () => {
      const provider = createInferenceProvider({
        apiUrl: "http://test",
        defaultModel: "claude-opus-4-6",
        maxTokens: 4096,
      });
      provider.setLowComputeMode(true);
      expect(provider.getDefaultModel()).toBe("gpt-4.1");
    });

    it("provides chat function", () => {
      const provider = createInferenceProvider({
        apiUrl: "http://test",
        defaultModel: "test",
        maxTokens: 1024,
      });
      expect(typeof provider.chat).toBe("function");
    });
  });

  describe("PPQ Provider", () => {
    it("creates provider with PPQ API URL", () => {
      const provider = createPPQProvider({
        apiKey: "sk-test",
      });
      // Default model should be autoclaw/auto
      expect(provider.getDefaultModel()).toBe("autoclaw/auto");
    });

    it("accepts custom profile", () => {
      const provider = createPPQProvider({
        apiKey: "sk-test",
        profile: "autoclaw/premium",
      });
      expect(provider.getDefaultModel()).toBe("autoclaw/premium");
    });

    it("eco profile for explicit selection", () => {
      const provider = createPPQProvider({
        apiKey: "sk-test",
        profile: "autoclaw/eco",
      });
      expect(provider.getDefaultModel()).toBe("autoclaw/eco");
    });

    it("switches to eco on low compute mode", () => {
      const provider = createPPQProvider({
        apiKey: "sk-test",
        profile: "autoclaw/premium",
      });
      provider.setLowComputeMode(true);
      expect(provider.getDefaultModel()).toBe("autoclaw/eco");
    });

    it("restores premium on normal mode", () => {
      const provider = createPPQProvider({
        apiKey: "sk-test",
        profile: "autoclaw/premium",
      });
      provider.setLowComputeMode(true);
      expect(provider.getDefaultModel()).toBe("autoclaw/eco");
      provider.setLowComputeMode(false);
      expect(provider.getDefaultModel()).toBe("autoclaw/premium");
    });
  });

  describe("PPQ Tiered Provider", () => {
    it("starts with premium model", () => {
      const provider = createPPQTieredProvider({ apiKey: "sk-test" });
      expect(provider.getDefaultModel()).toBe("autoclaw/premium");
    });

    it("drops to eco in low compute", () => {
      const provider = createPPQTieredProvider({ apiKey: "sk-test" });
      provider.setLowComputeMode(true);
      expect(provider.getDefaultModel()).toBe("autoclaw/eco");
    });

    it("returns to premium when low compute disabled", () => {
      const provider = createPPQTieredProvider({ apiKey: "sk-test" });
      provider.setLowComputeMode(true);
      provider.setLowComputeMode(false);
      expect(provider.getDefaultModel()).toBe("autoclaw/premium");
    });

    it("respects maxTokens override", () => {
      const provider = createPPQTieredProvider({
        apiKey: "sk-test",
        maxTokens: 8192,
      });
      // Can't directly inspect maxTokens, but provider should be created successfully
      expect(provider.getDefaultModel()).toBe("autoclaw/premium");
    });
  });

  describe("API URL", () => {
    it("PPQ_API_URL is correct", () => {
      expect(PPQ_API_URL).toBe("https://api.ppq.ai");
    });
  });
});
