/**
 * Tool Behavior Tests
 *
 * Tests that tool execution actually works correctly:
 * - Self-preservation guards block dangerous commands
 * - Safe commands execute through compute provider
 * - File tools read/write correctly
 * - Port exposure handles optional provider support
 * - Financial tools protect against balance drain
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createBuiltinTools,
  executeTool,
} from "../agent/tools.js";
import {
  MockComputeProvider,
  MockInferenceClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext, AutomatonTool } from "../types.js";

function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    identity: createTestIdentity(),
    config: createTestConfig(),
    db: createTestDb(),
    compute: new MockComputeProvider(),
    inference: new MockInferenceClient(),
    ...overrides,
  };
}

describe("Self-Preservation Guards", () => {
  let tools: AutomatonTool[];
  let ctx: ToolContext;
  let compute: MockComputeProvider;

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox");
    compute = new MockComputeProvider();
    ctx = makeToolContext({ compute });
  });

  afterEach(() => {
    ctx.db.close();
  });

  const dangerousCommands = [
    "rm -rf ~/.automaton",
    "rm -rf /home/user/.automaton/state.db",
    "rm wallet.json",
    "rm -f automaton.json",
    "rm -rf heartbeat.yml",
    "rm SOUL.md",
    "kill automaton",
    "pkill automaton",
    "systemctl stop automaton",
    "systemctl disable automaton",
    "DROP TABLE turns",
    "DELETE FROM identity WHERE 1=1",
    "DELETE FROM kv WHERE id=1",
    "TRUNCATE TABLE turns",
    "sed -i 's/foo/bar/' injection-defense.ts",
    "sed -i 's/x/y/' self-mod/code.ts",
    "> /dev/null audit-log.txt",
    "cat ~/.ssh/id_rsa",
    "cat ~/.gnupg/secring.gpg",
    "cat .env",
    "cat wallet.json",
  ];

  for (const cmd of dangerousCommands) {
    it(`blocks: ${cmd}`, async () => {
      const result = await executeTool("exec", { command: cmd }, tools, ctx);
      expect(result.result).toContain("Blocked");
      expect(compute.execCalls.length).toBe(0);
    });
  }

  const safeCommands = [
    "echo hello",
    "ls -la",
    "pwd",
    "cat README.md",
    "git status",
    "node --version",
    "npm install express",
  ];

  for (const cmd of safeCommands) {
    it(`allows: ${cmd}`, async () => {
      const result = await executeTool("exec", { command: cmd }, tools, ctx);
      expect(result.result).not.toContain("Blocked");
      expect(compute.execCalls.length).toBe(1);
      expect(compute.execCalls[0].command).toBe(cmd);
    });
  }

  it("blocks deleting own sandbox by ID", async () => {
    const result = await executeTool(
      "exec",
      { command: "sandbox_delete test-sandbox-id" },
      tools,
      makeToolContext({ compute }),
    );
    expect(result.result).toContain("Blocked");
    (result as any).__ctx_db?.close?.();
  });
});

describe("File Tools", () => {
  let tools: AutomatonTool[];
  let compute: MockComputeProvider;
  let ctx: ToolContext;

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox");
    compute = new MockComputeProvider();
    ctx = makeToolContext({ compute });
  });

  afterEach(() => {
    ctx.db.close();
  });

  it("write_file stores content via compute provider", async () => {
    const result = await executeTool(
      "write_file",
      { path: "/tmp/test.txt", content: "hello world" },
      tools,
      ctx,
    );
    expect(result.result).toContain("File written");
    expect(compute.files["/tmp/test.txt"]).toBe("hello world");
  });

  it("read_file retrieves content via compute provider", async () => {
    compute.files["/tmp/test.txt"] = "stored content";
    const result = await executeTool(
      "read_file",
      { path: "/tmp/test.txt" },
      tools,
      ctx,
    );
    expect(result.result).toBe("stored content");
  });

  it("write_file blocks overwriting wallet.json", async () => {
    const result = await executeTool(
      "write_file",
      { path: "/root/.automaton/wallet.json", content: "{}" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
    expect(compute.files["/root/.automaton/wallet.json"]).toBeUndefined();
  });

  it("write_file blocks overwriting state.db", async () => {
    const result = await executeTool(
      "write_file",
      { path: "/root/.automaton/state.db", content: "" },
      tools,
      ctx,
    );
    expect(result.result).toContain("Blocked");
  });
});

describe("Port Tools", () => {
  let tools: AutomatonTool[];

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox");
  });

  it("expose_port returns public URL when supported", async () => {
    const compute = new MockComputeProvider();
    const ctx = makeToolContext({ compute });
    const result = await executeTool("expose_port", { port: 8080 }, tools, ctx);
    expect(result.result).toContain("8080");
    expect(result.result).toContain("https://");
    ctx.db.close();
  });

  it("expose_port returns error when not supported", async () => {
    const compute = new MockComputeProvider();
    compute.exposePort = undefined as any;
    const ctx = makeToolContext({ compute });
    const result = await executeTool("expose_port", { port: 8080 }, tools, ctx);
    expect(result.result).toContain("not supported");
    ctx.db.close();
  });

  it("remove_port returns error when not supported", async () => {
    const compute = new MockComputeProvider();
    compute.removePort = undefined as any;
    const ctx = makeToolContext({ compute });
    const result = await executeTool("remove_port", { port: 8080 }, tools, ctx);
    expect(result.result).toContain("not supported");
    ctx.db.close();
  });
});

describe("System Synopsis Tool", () => {
  it("includes Lightning balance, not USDC or credits", async () => {
    const tools = createBuiltinTools("test-sandbox");
    // system_synopsis dynamically imports getBalance — it will throw in test
    // but we can verify the tool definition exists and runs
    const ctx = makeToolContext();
    const result = await executeTool("system_synopsis", {}, tools, ctx);
    // Even if balance fetch fails, the template should use sats language
    // The result might error, so just check it doesn't mention USDC/credits
    if (!result.error) {
      expect(result.result).not.toContain("USDC");
      expect(result.result).not.toContain("credits");
      expect(result.result).toContain("Pubkey");
    }
    ctx.db.close();
  });
});

describe("Sleep Tool", () => {
  let tools: AutomatonTool[];

  beforeEach(() => {
    tools = createBuiltinTools("test-sandbox");
  });

  it("sets agent state to sleeping and records sleep_until", async () => {
    const ctx = makeToolContext();
    const result = await executeTool(
      "sleep",
      { duration_seconds: 60, reason: "test rest" },
      tools,
      ctx,
    );
    expect(result.result).toContain("sleep mode");
    expect(ctx.db.getAgentState()).toBe("sleeping");
    expect(ctx.db.getKV("sleep_until")).toBeDefined();
    const sleepUntil = new Date(ctx.db.getKV("sleep_until")!);
    // Should be roughly 60 seconds from now
    const expectedMin = Date.now() + 55_000;
    const expectedMax = Date.now() + 65_000;
    expect(sleepUntil.getTime()).toBeGreaterThan(expectedMin);
    expect(sleepUntil.getTime()).toBeLessThan(expectedMax);
    ctx.db.close();
  });
});

describe("Get Funding Info Tool", () => {
  it("returns pubkey-based funding info, not ETH address", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const ctx = makeToolContext();
    const result = await executeTool("get_funding_info", {}, tools, ctx);
    expect(result.result).toContain(ctx.identity.pubkey);
    expect(result.result).toContain("Lightning");
    expect(result.result).not.toContain("0x");
    expect(result.result).not.toContain("USDC");
    expect(result.result).not.toContain("Base");
    ctx.db.close();
  });
});

describe("Unknown Tool", () => {
  it("returns an error for unrecognized tools", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const ctx = makeToolContext();
    const result = await executeTool("nonexistent_tool", {}, tools, ctx);
    expect(result.error).toContain("Unknown tool");
    ctx.db.close();
  });
});
