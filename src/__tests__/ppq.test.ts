/**
 * PPQ (PayPerQ) AutoClaw Integration Tests
 *
 * Tests the PPQ inference provider, AutoClaw routing profiles,
 * and survival tier → routing profile mapping.
 */

import { describe, it, expect } from "vitest";
import { getProfileForTier, PPQ_API_URL } from "../inference/ppq.js";
import { getModelForTier } from "../survival/low-compute.js";
import { DEFAULT_CONFIG } from "../types.js";
import { createTestConfig } from "./mocks.js";

describe("PPQ AutoClaw Routing", () => {
  describe("getProfileForTier", () => {
    it("maps normal → autoclaw/premium", () => {
      expect(getProfileForTier("normal")).toBe("autoclaw/premium");
    });

    it("maps low_compute → autoclaw/auto", () => {
      expect(getProfileForTier("low_compute")).toBe("autoclaw/auto");
    });

    it("maps critical → autoclaw/eco", () => {
      expect(getProfileForTier("critical")).toBe("autoclaw/eco");
    });

    it("maps dead → autoclaw/eco", () => {
      expect(getProfileForTier("dead")).toBe("autoclaw/eco");
    });
  });

  describe("getModelForTier with AutoClaw", () => {
    it("uses autoclaw/premium for normal tier", () => {
      expect(getModelForTier("normal", "autoclaw/auto")).toBe("autoclaw/premium");
    });

    it("uses autoclaw/auto for low_compute tier", () => {
      expect(getModelForTier("low_compute", "autoclaw/auto")).toBe("autoclaw/auto");
    });

    it("uses autoclaw/eco for critical tier", () => {
      expect(getModelForTier("critical", "autoclaw/auto")).toBe("autoclaw/eco");
    });

    it("uses autoclaw/eco for dead tier", () => {
      expect(getModelForTier("dead", "autoclaw/auto")).toBe("autoclaw/eco");
    });

    it("detects autoclaw model prefix correctly", () => {
      // Plain "autoclaw" should also trigger routing profiles
      expect(getModelForTier("normal", "autoclaw")).toBe("autoclaw/premium");
      expect(getModelForTier("low_compute", "autoclaw")).toBe("autoclaw/auto");
    });

    it("falls back to gpt-4o-mini for non-autoclaw models", () => {
      expect(getModelForTier("low_compute", "gpt-4o")).toBe("gpt-4o-mini");
      expect(getModelForTier("critical", "claude-sonnet-4-6")).toBe("gpt-4o-mini");
    });

    it("returns default model for normal tier with non-autoclaw", () => {
      expect(getModelForTier("normal", "gpt-4o")).toBe("gpt-4o");
    });
  });

  describe("Default Config", () => {
    it("defaults to PPQ as inference provider", () => {
      expect(DEFAULT_CONFIG.inferenceProvider).toBe("ppq");
    });

    it("defaults to ppq.ai API URL", () => {
      expect(DEFAULT_CONFIG.inferenceUrl).toBe("https://api.ppq.ai");
    });

    it("defaults to autoclaw/auto model", () => {
      expect(DEFAULT_CONFIG.inferenceModel).toBe("autoclaw/auto");
    });
  });

  describe("PPQ API URL", () => {
    it("exports the correct API URL", () => {
      expect(PPQ_API_URL).toBe("https://api.ppq.ai");
    });
  });

  describe("Config with PPQ", () => {
    it("can create config with ppq inference provider", () => {
      const config = createTestConfig({
        inferenceProvider: "ppq",
        inferenceUrl: "https://api.ppq.ai",
        inferenceModel: "autoclaw/auto",
        inferenceAuth: "sk-test-key",
      });
      expect(config.inferenceProvider).toBe("ppq");
      expect(config.inferenceUrl).toBe("https://api.ppq.ai");
      expect(config.inferenceModel).toBe("autoclaw/auto");
    });
  });

  describe("Survival Tier Cost Optimization", () => {
    it("premium profile is used when agent is well-funded", () => {
      // Agent with > 50k sats should get best models
      const profile = getProfileForTier("normal");
      expect(profile).toBe("autoclaw/premium");
    });

    it("eco profile conserves sats when balance is low", () => {
      // Agent with < 10k sats should minimize inference costs
      const profile = getProfileForTier("critical");
      expect(profile).toBe("autoclaw/eco");
    });

    it("auto profile balances cost and quality", () => {
      // Agent between 10k-50k sats gets balanced routing
      const profile = getProfileForTier("low_compute");
      expect(profile).toBe("autoclaw/auto");
    });
  });
});
