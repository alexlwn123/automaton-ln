/**
 * Config Tests
 *
 * Tests config creation, PPQ defaults, persistence, and path resolution.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createConfig, resolvePath } from "../config.js";
import { DEFAULT_CONFIG } from "../types.js";

describe("Config", () => {
  describe("createConfig", () => {
    it("creates config with PPQ defaults when no inference provider specified", () => {
      const config = createConfig({
        name: "test-agent",
        genesisPrompt: "Be helpful",
        creatorPubkey: "03abc123",
        nodePubkey: "02def456",
      });
      expect(config.inferenceProvider).toBe("ppq");
      expect(config.inferenceUrl).toBe("https://api.ppq.ai");
      expect(config.inferenceModel).toBe("autoclaw/auto");
    });

    it("uses OpenAI URL when provider is openai", () => {
      const config = createConfig({
        name: "test",
        genesisPrompt: "test",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
        inferenceProvider: "openai",
      });
      expect(config.inferenceProvider).toBe("openai");
      expect(config.inferenceUrl).toBe("https://api.openai.com/v1");
      expect(config.inferenceModel).toBe("gpt-4o");
    });

    it("uses custom URL when provided", () => {
      const config = createConfig({
        name: "test",
        genesisPrompt: "test",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
        inferenceProvider: "custom",
        inferenceUrl: "http://localhost:11434/v1",
      });
      expect(config.inferenceProvider).toBe("custom");
      expect(config.inferenceUrl).toBe("http://localhost:11434/v1");
    });

    it("stores inference auth key", () => {
      const config = createConfig({
        name: "test",
        genesisPrompt: "test",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
        inferenceAuth: "sk-ppq-test-key",
      });
      expect(config.inferenceAuth).toBe("sk-ppq-test-key");
    });

    it("sets all required fields", () => {
      const config = createConfig({
        name: "sovereign-agent",
        genesisPrompt: "Earn your existence",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
      });
      expect(config.name).toBe("sovereign-agent");
      expect(config.genesisPrompt).toBe("Earn your existence");
      expect(config.creatorPubkey).toBe("03abc");
      expect(config.nodePubkey).toBe("02def");
      expect(config.computeProvider).toBe("local");
      expect(config.maxTokensPerTurn).toBe(4096);
      expect(config.maxChildren).toBe(3);
      expect(config.logLevel).toBe("info");
    });

    it("accepts optional parentPubkey for child agents", () => {
      const config = createConfig({
        name: "child",
        genesisPrompt: "test",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
        parentPubkey: "03parent",
      });
      expect(config.parentPubkey).toBe("03parent");
    });

    it("accepts LNVPS compute config", () => {
      const config = createConfig({
        name: "test",
        genesisPrompt: "test",
        creatorPubkey: "03abc",
        nodePubkey: "02def",
        computeProvider: "lnvps",
        computeConfig: {
          lnvpsUrl: "https://lnvps.net/api/v1",
          vmId: 42,
          sshHost: "1.2.3.4",
        },
      });
      expect(config.computeProvider).toBe("lnvps");
      expect(config.computeConfig?.vmId).toBe(42);
      expect(config.computeConfig?.sshHost).toBe("1.2.3.4");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("defaults to PPQ", () => {
      expect(DEFAULT_CONFIG.inferenceProvider).toBe("ppq");
      expect(DEFAULT_CONFIG.inferenceUrl).toBe("https://api.ppq.ai");
      expect(DEFAULT_CONFIG.inferenceModel).toBe("autoclaw/auto");
    });

    it("defaults to local compute", () => {
      expect(DEFAULT_CONFIG.computeProvider).toBe("local");
    });
  });

  describe("resolvePath", () => {
    it("resolves ~ to home directory", () => {
      const resolved = resolvePath("~/.automaton/state.db");
      expect(resolved).not.toContain("~");
      expect(resolved).toContain("/.automaton/state.db");
    });

    it("leaves absolute paths unchanged", () => {
      expect(resolvePath("/tmp/test")).toBe("/tmp/test");
    });

    it("leaves relative paths unchanged", () => {
      expect(resolvePath("./test")).toBe("./test");
    });
  });
});
