/**
 * Lightning Payment Module
 *
 * Core payment functions for the automaton.
 * Wraps the MDK agent wallet CLI for Lightning operations.
 * Includes MDK402 (L402) support for pay-per-call APIs.
 */

import {
  getBalance as walletGetBalance,
  createInvoice as walletCreateInvoice,
  sendPayment as walletSendPayment,
  ensureDaemon,
} from "../identity/wallet.js";

export interface Invoice {
  invoice: string;
  paymentHash: string;
  expiresAt: string;
}

export interface PaymentResult {
  paymentHash: string;
  preimage?: string;
}

export interface Mdk402Challenge {
  token: string;
  invoice: string;
  paymentHash: string;
  amountSats: number;
  expiresAt: number;
}

/**
 * Create a BOLT11 invoice to receive payment.
 */
export async function createInvoice(
  amountSats: number,
  memo?: string,
): Promise<Invoice> {
  return walletCreateInvoice(amountSats, memo);
}

/**
 * Pay a BOLT11 invoice.
 */
export async function payInvoice(bolt11: string): Promise<PaymentResult> {
  return walletSendPayment(bolt11);
}

/**
 * Send sats to a Lightning address (user@domain.com).
 */
export async function sendToAddress(
  address: string,
  amountSats: number,
): Promise<PaymentResult> {
  return walletSendPayment(address, amountSats);
}

/**
 * Get current balance in sats.
 */
export async function getBalance(): Promise<number> {
  const result = await walletGetBalance();
  return result.balanceSats;
}

/**
 * Fetch a URL with automatic MDK402 (L402) payment.
 *
 * Flow:
 * 1. GET/POST the URL
 * 2. If 402 → parse { token, invoice } from response
 * 3. Pay the invoice via Lightning, get preimage
 * 4. Retry with Authorization: MDK402 <token>:<preimage>
 * 5. Return the final response
 */
export async function mdk402Fetch(
  url: string,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
): Promise<{ success: boolean; status: number; data: any; error?: string }> {
  try {
    ensureDaemon();

    // Step 1: Initial request
    const initialResp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: method !== "GET" ? body : undefined,
    });

    // Not a 402 — return as-is
    if (initialResp.status !== 402) {
      const data = await initialResp.json().catch(() => initialResp.text());
      return { success: initialResp.ok, status: initialResp.status, data };
    }

    // Step 2: Parse the 402 challenge
    let challenge: Mdk402Challenge;
    try {
      const respBody = await initialResp.json();
      challenge = {
        token: respBody.token,
        invoice: respBody.invoice,
        paymentHash: respBody.paymentHash,
        amountSats: respBody.amountSats,
        expiresAt: respBody.expiresAt,
      };
    } catch {
      // Try WWW-Authenticate header
      const authHeader = initialResp.headers.get("WWW-Authenticate");
      if (!authHeader) {
        return {
          success: false,
          status: 402,
          data: null,
          error: "Could not parse 402 payment challenge",
        };
      }
      const tokenMatch = authHeader.match(/token="([^"]+)"/);
      const invoiceMatch = authHeader.match(/invoice="([^"]+)"/);
      if (!tokenMatch || !invoiceMatch) {
        return {
          success: false,
          status: 402,
          data: null,
          error: "Could not parse WWW-Authenticate header",
        };
      }
      challenge = {
        token: tokenMatch[1],
        invoice: invoiceMatch[1],
        paymentHash: "",
        amountSats: 0,
        expiresAt: 0,
      };
    }

    if (!challenge.token || !challenge.invoice) {
      return {
        success: false,
        status: 402,
        data: null,
        error: "Missing token or invoice in 402 response",
      };
    }

    // Step 3: Pay the invoice
    let payResult: PaymentResult;
    try {
      payResult = await payInvoice(challenge.invoice);
    } catch (err: any) {
      return {
        success: false,
        status: 402,
        data: null,
        error: `Failed to pay invoice: ${err.message}`,
      };
    }

    if (!payResult.preimage) {
      return {
        success: false,
        status: 402,
        data: null,
        error: "Payment succeeded but no preimage returned",
      };
    }

    // Step 4: Retry with proof of payment
    const paidResp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
        Authorization: `MDK402 ${challenge.token}:${payResult.preimage}`,
      },
      body: method !== "GET" ? body : undefined,
    });

    const data = await paidResp.json().catch(() => paidResp.text());
    return { success: paidResp.ok, status: paidResp.status, data };
  } catch (err: any) {
    return { success: false, status: 0, data: null, error: err.message };
  }
}
