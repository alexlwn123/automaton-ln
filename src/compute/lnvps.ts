/**
 * LNVPS Compute Provider
 *
 * Provisions and manages VPS instances from lnvps.net,
 * a no-KYC VPS provider that accepts Lightning payments.
 *
 * Auth: NIP-98 (signed Nostr events as HTTP Authorization header)
 * Payment: Lightning invoices via MDK
 * Execution: SSH into the provisioned VPS
 *
 * API base: https://lnvps.net/api/v1
 *
 * Endpoints used:
 *   POST   /vm              — Create VM
 *   GET    /vm/{id}         — VM status
 *   GET    /vm/{id}/renew   — Get renewal invoice
 *   PATCH  /vm/{id}/start   — Start VM
 *   PATCH  /vm/{id}/stop    — Stop VM
 *   PATCH  /vm/{id}/restart — Restart VM
 *   GET    /vm/templates    — List available templates/pricing
 *   POST   /ssh-key         — Register SSH key
 *   GET    /payment/{id}    — Poll payment status
 */

import { execSync } from "child_process";
import type { ComputeProvider, ExecResult, PortInfo } from "../types.js";
import { createNip98Token, type NostrIdentity } from "../identity/nostr.js";

const DEFAULT_API_URL = "https://lnvps.net/api/v1";
const SSH_TIMEOUT_MS = 30_000;

export interface LnvpsConfig {
  apiUrl?: string;
  nostrIdentity: NostrIdentity;
  vmId?: number;
  sshHost?: string;
  sshUser?: string;
  sshKeyPath?: string;
}

export interface VmTemplate {
  id: number;
  name: string;
  cpu: number;
  memory: number; // MB
  disk: number; // GB
  priceSats: number; // monthly
  region: string;
}

export interface VmInfo {
  id: number;
  status: string;
  ip?: string;
  template: number;
  expiresAt?: string;
  sshHost?: string;
}

export interface LnvpsPayment {
  id: string;
  invoice: string;
  amountSats: number;
  isPaid: boolean;
}

/**
 * Make an authenticated request to the LNVPS API.
 */
async function lnvpsRequest(
  apiUrl: string,
  path: string,
  method: string,
  nostrId: NostrIdentity,
  body?: Record<string, unknown>,
): Promise<any> {
  const url = `${apiUrl}${path}`;
  const token = await createNip98Token(url, method, nostrId.secretKey);

  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Nostr ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`LNVPS API error (${resp.status} ${method} ${path}): ${text}`);
  }

  return resp.json();
}

// ─── VM Lifecycle Management ────────────────────────────────────

/**
 * List available VM templates and pricing.
 */
export async function listTemplates(
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<VmTemplate[]> {
  const data = await lnvpsRequest(apiUrl, "/vm/templates", "GET", nostrId);
  return (data.templates || data || []).map((t: any) => ({
    id: t.id,
    name: t.name || `${t.cpu}vCPU/${t.memory}MB/${t.disk}GB`,
    cpu: t.cpu,
    memory: t.memory,
    disk: t.disk,
    priceSats: t.cost_plan?.amount || t.price_sats || 0,
    region: t.region || "unknown",
  }));
}

/**
 * Register an SSH key with LNVPS.
 */
export async function registerSshKey(
  name: string,
  publicKey: string,
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<{ id: number }> {
  return lnvpsRequest(apiUrl, "/ssh-key", "POST", nostrId, {
    name,
    key: publicKey,
  });
}

/**
 * Create a new VM.
 */
export async function createVm(
  templateId: number,
  imageId: number,
  sshKeyId: number,
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<VmInfo> {
  return lnvpsRequest(apiUrl, "/vm", "POST", nostrId, {
    template_id: templateId,
    image_id: imageId,
    ssh_key_id: sshKeyId,
  });
}

/**
 * Get VM status.
 */
export async function getVmStatus(
  vmId: number,
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<VmInfo> {
  return lnvpsRequest(apiUrl, `/vm/${vmId}`, "GET", nostrId);
}

/**
 * Get a renewal/payment invoice for a VM.
 */
export async function getRenewalInvoice(
  vmId: number,
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<LnvpsPayment> {
  return lnvpsRequest(
    apiUrl,
    `/vm/${vmId}/renew?method=lightning`,
    "GET",
    nostrId,
  );
}

/**
 * Check payment status.
 */
export async function checkPayment(
  paymentId: string,
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<LnvpsPayment> {
  return lnvpsRequest(apiUrl, `/payment/${paymentId}`, "GET", nostrId);
}

/**
 * Start/stop/restart a VM.
 */
export async function controlVm(
  vmId: number,
  action: "start" | "stop" | "restart",
  nostrId: NostrIdentity,
  apiUrl: string = DEFAULT_API_URL,
): Promise<void> {
  await lnvpsRequest(apiUrl, `/vm/${vmId}/${action}`, "PATCH", nostrId);
}

// ─── ComputeProvider Implementation ─────────────────────────────

/**
 * Create an LNVPS-backed ComputeProvider.
 * Executes commands and manages files via SSH to the provisioned VPS.
 */
export function createLnvpsProvider(config: LnvpsConfig): ComputeProvider {
  const sshUser = config.sshUser || "root";
  const sshKeyPath = config.sshKeyPath || "~/.ssh/id_ed25519";

  function getSshHost(): string {
    if (config.sshHost) return config.sshHost;
    throw new Error(
      "LNVPS: No SSH host configured. Provision a VM first (set sshHost in computeConfig).",
    );
  }

  function sshCommand(command: string, timeoutMs: number = SSH_TIMEOUT_MS): string {
    const host = getSshHost();
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${sshKeyPath} ${sshUser}@${host} ${JSON.stringify(command)}`;
    return sshCmd;
  }

  return {
    exec: async (command: string, timeout?: number): Promise<ExecResult> => {
      const sshCmd = sshCommand(command, timeout);
      try {
        const stdout = execSync(sshCmd, {
          timeout: timeout || SSH_TIMEOUT_MS,
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (err: any) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || err.message,
          exitCode: err.status ?? 1,
        };
      }
    },

    writeFile: async (filePath: string, content: string): Promise<void> => {
      const host = getSshHost();
      // Use heredoc over SSH to write file content
      const escaped = content.replace(/'/g, "'\\''");
      const cmd = `ssh -o StrictHostKeyChecking=no -i ${sshKeyPath} ${sshUser}@${host} "mkdir -p $(dirname ${JSON.stringify(filePath)}) && cat > ${JSON.stringify(filePath)}" <<'LNVPS_EOF'\n${escaped}\nLNVPS_EOF`;
      execSync(cmd, { timeout: SSH_TIMEOUT_MS, encoding: "utf-8" });
    },

    readFile: async (filePath: string): Promise<string> => {
      const host = getSshHost();
      const cmd = `ssh -o StrictHostKeyChecking=no -i ${sshKeyPath} ${sshUser}@${host} cat ${JSON.stringify(filePath)}`;
      return execSync(cmd, { timeout: SSH_TIMEOUT_MS, encoding: "utf-8" });
    },

    // Port exposure not directly supported on LNVPS — VM has a public IP
    // The agent can configure its own reverse proxy or firewall rules
  };
}
