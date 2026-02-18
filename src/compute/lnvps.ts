/**
 * LNVPS Compute Provider
 *
 * No-KYC VPS provisioning via Lightning payments.
 * Auth: NIP-98 (signed Nostr events)
 * Payment: Lightning invoices
 * API: https://lnvps.net/api/v1
 *
 * The automaton creates a VPS, pays with Lightning, SSHes in.
 * If it can't pay the renewal, the VPS expires and the automaton dies.
 */

import type { ComputeProvider, ExecResult } from "../types.js";
import { payInvoice } from "../lightning/payments.js";

// ─── Types ───────────────────────────────────────────────────────

export interface LnvpsConfig {
  apiUrl: string; // default: https://lnvps.net
  vmId?: number;
  sshHost?: string;
  sshUser?: string;
  sshKeyPath?: string;
}

export interface VmTemplate {
  id: number;
  cpu: number;
  memory: number;
  disk: number;
  region: string;
  cost: { amount: number; currency: string };
}

export interface VmStatus {
  id: number;
  status: string;
  ipv4?: string;
  ipv6?: string;
  expiresAt?: string;
}

export interface VmPayment {
  id: string;
  invoice: string;
  amountSats: number;
  isPaid: boolean;
}

// ─── NIP-98 Auth (placeholder) ──────────────────────────────────

/**
 * Create a NIP-98 Authorization header.
 * Requires nostr-tools for real implementation.
 * TODO: implement with nostr-tools when adding full LNVPS support
 */
function createNip98Auth(_url: string, _method: string): string {
  // Placeholder — real implementation signs a Nostr event (kind 27235)
  // with the URL and method, then base64-encodes it
  throw new Error(
    "NIP-98 auth not yet implemented. Install nostr-tools and implement signing.",
  );
}

// ─── LNVPS API Client ───────────────────────────────────────────

export class LnvpsClient {
  private apiUrl: string;

  constructor(apiUrl: string = "https://lnvps.net") {
    this.apiUrl = apiUrl;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const url = `${this.apiUrl}${path}`;
    const auth = createNip98Auth(url, method);

    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Nostr ${auth}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`LNVPS API error: ${method} ${path} -> ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  /** List available VM templates with pricing */
  async listTemplates(): Promise<VmTemplate[]> {
    const result = await this.request("GET", "/api/v1/vm/templates");
    return result.templates || [];
  }

  /** Create a VM order (initially unpaid/expired) */
  async createVm(templateId: number, imageId: number, sshKeyId: number): Promise<VmStatus> {
    return this.request("POST", "/api/v1/vm", {
      template_id: templateId,
      image_id: imageId,
      ssh_key_id: sshKeyId,
    });
  }

  /** Get VM status */
  async getVmStatus(vmId: number): Promise<VmStatus> {
    return this.request("GET", `/api/v1/vm/${vmId}`);
  }

  /** Get Lightning invoice to renew/pay for VM */
  async renewVm(vmId: number): Promise<VmPayment> {
    return this.request("GET", `/api/v1/vm/${vmId}/renew?method=lightning`);
  }

  /** Start VM */
  async startVm(vmId: number): Promise<void> {
    await this.request("PATCH", `/api/v1/vm/${vmId}/start`);
  }

  /** Stop VM */
  async stopVm(vmId: number): Promise<void> {
    await this.request("PATCH", `/api/v1/vm/${vmId}/stop`);
  }

  /** Restart VM */
  async restartVm(vmId: number): Promise<void> {
    await this.request("PATCH", `/api/v1/vm/${vmId}/restart`);
  }

  /** Add SSH key to account */
  async addSshKey(name: string, keyData: string): Promise<{ id: number }> {
    return this.request("POST", "/api/v1/ssh-key", { name, key_data: keyData });
  }

  /** Pay for a VM using Lightning */
  async payForVm(vmId: number): Promise<{ paymentHash: string }> {
    const payment = await this.renewVm(vmId);
    if (!payment.invoice) {
      throw new Error("No invoice returned from LNVPS");
    }
    return payInvoice(payment.invoice);
  }
}

// ─── SSH-based Compute Provider for LNVPS ───────────────────────

/**
 * Create a compute provider that executes commands on an LNVPS VM via SSH.
 * Requires the VM to be provisioned and accessible.
 */
export function createLnvpsProvider(config: LnvpsConfig): ComputeProvider {
  const { sshHost, sshUser = "root", sshKeyPath } = config;

  if (!sshHost) {
    throw new Error("LNVPS provider requires sshHost in config");
  }

  const sshPrefix = sshKeyPath
    ? `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no ${sshUser}@${sshHost}`
    : `ssh -o StrictHostKeyChecking=no ${sshUser}@${sshHost}`;

  const exec = async (
    command: string,
    timeout?: number,
  ): Promise<ExecResult> => {
    const { execSync } = await import("child_process");
    try {
      const stdout = execSync(
        `${sshPrefix} '${command.replace(/'/g, "'\\''")}'`,
        {
          encoding: "utf-8",
          timeout: timeout || 30000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
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
    const { execSync } = await import("child_process");
    const escaped = content.replace(/'/g, "'\\''");
    execSync(
      `${sshPrefix} 'mkdir -p $(dirname "${filePath}") && cat > "${filePath}" << '\\''HEREDOC'\\''
${escaped}
HEREDOC'`,
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
    );
  };

  const readFile = async (filePath: string): Promise<string> => {
    const result = await exec(`cat "${filePath}"`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read ${filePath}: ${result.stderr}`);
    }
    return result.stdout;
  };

  return { exec, writeFile, readFile };
}
