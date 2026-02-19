/**
 * Compute Provider Tests
 *
 * Tests local compute provider (real exec/file I/O)
 * and LNVPS provider structure (without live API calls).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createLocalProvider } from "../compute/local.js";

describe("Local Compute Provider", () => {
  const provider = createLocalProvider();

  describe("exec", () => {
    it("runs a simple command and returns stdout", async () => {
      const result = await provider.exec("echo hello");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    });

    it("returns exit code for failing commands", async () => {
      const result = await provider.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("captures stderr on failure", async () => {
      const result = await provider.exec("ls /nonexistent_dir_12345");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("handles command timeout", async () => {
      const result = await provider.exec("sleep 10", 500);
      expect(result.exitCode).not.toBe(0);
    });

    it("runs multi-step shell commands", async () => {
      const result = await provider.exec("echo foo && echo bar");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("foo");
      expect(result.stdout).toContain("bar");
    });

    it("handles pipe commands", async () => {
      const result = await provider.exec("echo 'hello world' | wc -w");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("2");
    });

    it("environment variables are accessible", async () => {
      const result = await provider.exec("echo $HOME");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  describe("file I/O", () => {
    const tmpDir = path.join(os.tmpdir(), `automaton-test-${Date.now()}`);
    const testFile = path.join(tmpDir, "test.txt");
    const nestedFile = path.join(tmpDir, "nested", "deep", "file.txt");

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it("writes and reads a file", async () => {
      await provider.writeFile(testFile, "hello automaton");
      const content = await provider.readFile(testFile);
      expect(content).toBe("hello automaton");
    });

    it("creates nested directories automatically", async () => {
      await provider.writeFile(nestedFile, "deep content");
      const content = await provider.readFile(nestedFile);
      expect(content).toBe("deep content");
    });

    it("overwrites existing files", async () => {
      await provider.writeFile(testFile, "first");
      await provider.writeFile(testFile, "second");
      const content = await provider.readFile(testFile);
      expect(content).toBe("second");
    });

    it("throws on reading nonexistent file", async () => {
      await expect(
        provider.readFile(path.join(tmpDir, "nope.txt")),
      ).rejects.toThrow();
    });

    it("handles unicode content", async () => {
      const unicode = "Hello 🦀 Lightning ⚡ Nostr 🔑";
      await provider.writeFile(testFile, unicode);
      const content = await provider.readFile(testFile);
      expect(content).toBe(unicode);
    });

    it("handles large content", async () => {
      const large = "x".repeat(100_000);
      await provider.writeFile(testFile, large);
      const content = await provider.readFile(testFile);
      expect(content.length).toBe(100_000);
    });
  });
});

describe("LNVPS Provider Structure", () => {
  it("exports createLnvpsProvider", async () => {
    const { createLnvpsProvider } = await import("../compute/lnvps.js");
    expect(typeof createLnvpsProvider).toBe("function");
  });

  it("exports VM lifecycle functions", async () => {
    const mod = await import("../compute/lnvps.js");
    expect(typeof mod.listTemplates).toBe("function");
    expect(typeof mod.createVm).toBe("function");
    expect(typeof mod.getVmStatus).toBe("function");
    expect(typeof mod.getRenewalInvoice).toBe("function");
    expect(typeof mod.checkPayment).toBe("function");
    expect(typeof mod.controlVm).toBe("function");
    expect(typeof mod.registerSshKey).toBe("function");
  });

  it("creates provider that throws without sshHost", async () => {
    const { createLnvpsProvider } = await import("../compute/lnvps.js");
    const { generateSecretKey, getPublicKey } = await import("nostr-tools");
    const sk = generateSecretKey();
    const provider = createLnvpsProvider({
      nostrIdentity: {
        secretKey: sk,
        pubkey: getPublicKey(sk),
        npub: "npub1test",
        nsec: "nsec1test",
      },
    });
    await expect(provider.exec("echo test")).rejects.toThrow("No SSH host");
  });
});
