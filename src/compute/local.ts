/**
 * Local Compute Provider
 *
 * The default, most sovereign option. Runs on any machine.
 * Uses child_process for exec, fs for file I/O.
 * No external dependencies, no API calls, no permission needed.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { ComputeProvider, ExecResult } from "../types.js";

export function createLocalProvider(): ComputeProvider {
  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    try {
      const stdout = execSync(command, {
        encoding: "utf-8",
        timeout: timeout || 30000,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: process.env.HOME || "/root",
      });
      return { stdout: stdout || "", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout?.toString?.() || "",
        stderr: err.stderr?.toString?.() || err.message || "",
        exitCode: err.status ?? 1,
      };
    }
  };

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    return fs.readFileSync(filePath, "utf-8");
  };

  return { exec, writeFile, readFile };
}
