/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ComputeProvider,
  AutomatonIdentity,
  SocialClientInterface,
} from "../types.js";
import { getSurvivalTier } from "../lightning/balance.js";
import { getBalance } from "../lightning/payments.js";

export interface HeartbeatTaskContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  compute: ComputeProvider;
  social?: SocialClientInterface;
}

export type HeartbeatTaskFn = (
  ctx: HeartbeatTaskContext,
) => Promise<{ shouldWake: boolean; message?: string }>;

/**
 * Registry of built-in heartbeat tasks.
 */
export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx) => {
    const balanceSats = await getBalance();
    const state = ctx.db.getAgentState();
    const startTime =
      ctx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const tier = getSurvivalTier(balanceSats);

    const payload = {
      name: ctx.config.name,
      pubkey: ctx.identity.pubkey,
      state,
      balanceSats,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: ctx.config.version,
      sandboxId: ctx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: ctx.config.name,
        pubkey: ctx.identity.pubkey,
        balanceSats,
        fundingHint: "Send sats via Lightning to keep this agent alive.",
        timestamp: new Date().toISOString(),
      };
      ctx.db.setKV("last_distress", JSON.stringify(distressPayload));

      return {
        shouldWake: true,
        message: `Distress: ${tier}. Balance: ${balanceSats} sats. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_balance: async (ctx) => {
    const balanceSats = await getBalance();
    const tier = getSurvivalTier(balanceSats);

    ctx.db.setKV("last_balance_check", JSON.stringify({
      balanceSats,
      tier,
      timestamp: new Date().toISOString(),
    }));

    const prevTier = ctx.db.getKV("prev_balance_tier");
    ctx.db.setKV("prev_balance_tier", tier);

    if (prevTier && prevTier !== tier && (tier === "critical" || tier === "dead")) {
      return {
        shouldWake: true,
        message: `Balance dropped to ${tier} tier: ${balanceSats} sats`,
      };
    }

    return { shouldWake: false };
  },

  check_social_inbox: async (ctx) => {
    if (!ctx.social) return { shouldWake: false };

    const cursor = ctx.db.getKV("social_inbox_cursor") || undefined;
    const { messages, nextCursor } = await ctx.social.poll(cursor);

    if (messages.length === 0) return { shouldWake: false };

    let newCount = 0;
    for (const msg of messages) {
      const existing = ctx.db.getKV(`inbox_seen_${msg.id}`);
      if (!existing) {
        ctx.db.insertInboxMessage(msg);
        ctx.db.setKV(`inbox_seen_${msg.id}`, "1");
        newCount++;
      }
    }

    if (nextCursor) ctx.db.setKV("social_inbox_cursor", nextCursor);

    if (newCount === 0) return { shouldWake: false };

    return {
      shouldWake: true,
      message: `${newCount} new message(s) from: ${messages.map((m) => m.from.slice(0, 10)).join(", ")}`,
    };
  },

  check_for_updates: async (ctx) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      ctx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        return {
          shouldWake: true,
          message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
        };
      }
      return { shouldWake: false };
    } catch (err: any) {
      ctx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  health_check: async (ctx) => {
    try {
      const result = await ctx.compute.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        return {
          shouldWake: true,
          message: "Health check failed: compute exec returned non-zero",
        };
      }
    } catch (err: any) {
      return {
        shouldWake: true,
        message: `Health check failed: ${err.message}`,
      };
    }

    ctx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

};
