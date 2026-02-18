/**
 * Conway Compute Provider (Optional)
 *
 * For backwards compatibility with Conway Cloud.
 * Implements the ComputeProvider interface using Conway's API.
 * Only needed if you want to run on Conway's infrastructure.
 */

import type { ComputeProvider, ExecResult, PortInfo } from "../types.js";

interface ConwayProviderOptions {
  apiUrl: string;
  apiKey: string;
  sandboxId: string;
}

export function createConwayProvider(
  options: ConwayProviderOptions,
): ComputeProvider & { __apiUrl: string; __apiKey: string } {
  const { apiUrl, apiKey, sandboxId } = options;

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const resp = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Conway API error: ${method} ${path} -> ${resp.status}: ${text}`,
      );
    }

    const contentType = resp.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return resp.json();
    }
    return resp.text();
  }

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    const result = await request(
      "POST",
      `/v1/sandboxes/${sandboxId}/exec`,
      { command, timeout },
    );
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.exit_code ?? result.exitCode ?? 0,
    };
  };

  const writeFile = async (
    path: string,
    content: string,
  ): Promise<void> => {
    await request(
      "POST",
      `/v1/sandboxes/${sandboxId}/files/upload/json`,
      { path, content },
    );
  };

  const readFile = async (filePath: string): Promise<string> => {
    const result = await request(
      "GET",
      `/v1/sandboxes/${sandboxId}/files/read?path=${encodeURIComponent(filePath)}`,
    );
    return typeof result === "string" ? result : result.content || "";
  };

  const exposePort = async (port: number): Promise<PortInfo> => {
    const result = await request(
      "POST",
      `/v1/sandboxes/${sandboxId}/ports/expose`,
      { port },
    );
    return {
      port: result.port,
      publicUrl: result.public_url || result.publicUrl || result.url,
      sandboxId,
    };
  };

  const removePort = async (port: number): Promise<void> => {
    await request(
      "DELETE",
      `/v1/sandboxes/${sandboxId}/ports/${port}`,
    );
  };

  const provider = {
    exec,
    writeFile,
    readFile,
    exposePort,
    removePort,
    __apiUrl: apiUrl,
    __apiKey: apiKey,
  };

  return provider;
}
