/**
 * Survival System Tests
 *
 * Tests tier transitions, restrictions, model selection,
 * and the full survival flow without live balance checks.
 */

import { describe, it, expect } from "vitest";
import {
  applyTierRestrictions,
  recordTransition,
  canRunInference,
  getModelForTier,
} from "../survival/low-compute.js";
import { getSurvivalTier, formatBalance } from "../lightning/balance.js";
import { SURVIVAL_THRESHOLDS } from "../types.js";
import { createTestDb, MockInferenceClient } from "./mocks.js";

describe("Survival System", () => {
  describe("Tier Thresholds", () => {
    it("normal tier at threshold and above", () => {
      expect(getSurvivalTier(50000)).toBe("normal");
      expect(getSurvivalTier(100000)).toBe("normal");
      expect(getSurvivalTier(999999)).toBe("normal");
      // Just below threshold
      expect(getSurvivalTier(49999)).toBe("low_compute");
    });

    it("low_compute between 10000-49999 sats", () => {
      expect(getSurvivalTier(10000)).toBe("low_compute");
      expect(getSurvivalTier(49999)).toBe("low_compute");
      // Just below threshold
      expect(getSurvivalTier(9999)).toBe("critical");
    });

    it("critical between 1000-9999 sats", () => {
      expect(getSurvivalTier(1000)).toBe("critical");
      expect(getSurvivalTier(9999)).toBe("critical");
      // Just below threshold
      expect(getSurvivalTier(999)).toBe("dead");
    });

    it("dead below 1000 sats", () => {
      expect(getSurvivalTier(0)).toBe("dead");
      expect(getSurvivalTier(999)).toBe("dead");
      expect(getSurvivalTier(1)).toBe("dead");
    });

    it("threshold constants are sane", () => {
      expect(SURVIVAL_THRESHOLDS.normal).toBeGreaterThan(SURVIVAL_THRESHOLDS.low_compute);
      expect(SURVIVAL_THRESHOLDS.low_compute).toBeGreaterThan(SURVIVAL_THRESHOLDS.critical);
      expect(SURVIVAL_THRESHOLDS.dead).toBe(0);
    });
  });

  describe("Tier Restrictions", () => {
    it("normal tier enables full compute", () => {
      const inference = new MockInferenceClient();
      const db = createTestDb();
      applyTierRestrictions("normal", inference, db);
      expect(inference.lowComputeMode).toBe(false);
    });

    it("low_compute enables low compute mode", () => {
      const inference = new MockInferenceClient();
      const db = createTestDb();
      applyTierRestrictions("low_compute", inference, db);
      expect(inference.lowComputeMode).toBe(true);
    });

    it("critical enables low compute mode", () => {
      const inference = new MockInferenceClient();
      const db = createTestDb();
      applyTierRestrictions("critical", inference, db);
      expect(inference.lowComputeMode).toBe(true);
    });

    it("dead enables low compute mode", () => {
      const inference = new MockInferenceClient();
      const db = createTestDb();
      applyTierRestrictions("dead", inference, db);
      expect(inference.lowComputeMode).toBe(true);
    });

    it("stores tier in database", () => {
      const inference = new MockInferenceClient();
      const db = createTestDb();
      applyTierRestrictions("critical", inference, db);
      expect(db.getKV("current_tier")).toBe("critical");
    });
  });

  describe("canRunInference", () => {
    it("allows inference in normal tier", () => {
      expect(canRunInference("normal")).toBe(true);
    });

    it("allows inference in low_compute", () => {
      expect(canRunInference("low_compute")).toBe(true);
    });

    it("allows inference in critical (last resort)", () => {
      expect(canRunInference("critical")).toBe(true);
    });

    it("blocks inference when dead", () => {
      expect(canRunInference("dead")).toBe(false);
    });
  });

  describe("getModelForTier", () => {
    describe("with AutoClaw (PPQ)", () => {
      it("premium for normal", () => {
        expect(getModelForTier("normal", "autoclaw/auto")).toBe("autoclaw/premium");
      });

      it("auto for low_compute", () => {
        expect(getModelForTier("low_compute", "autoclaw/auto")).toBe("autoclaw/auto");
      });

      it("eco for critical", () => {
        expect(getModelForTier("critical", "autoclaw/auto")).toBe("autoclaw/eco");
      });

      it("eco for dead", () => {
        expect(getModelForTier("dead", "autoclaw")).toBe("autoclaw/eco");
      });
    });

    describe("with direct models", () => {
      it("returns default model for normal", () => {
        expect(getModelForTier("normal", "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
      });

      it("downgrades to gpt-4o-mini for low tiers", () => {
        expect(getModelForTier("low_compute", "claude-sonnet-4-6")).toBe("gpt-4o-mini");
        expect(getModelForTier("critical", "gpt-4o")).toBe("gpt-4o-mini");
      });
    });
  });

  describe("Transition Recording", () => {
    it("records a transition", () => {
      const db = createTestDb();
      const transition = recordTransition(db, "normal", "low_compute", 15000);
      expect(transition.from).toBe("normal");
      expect(transition.to).toBe("low_compute");
      expect(transition.balanceSats).toBe(15000);
      expect(transition.timestamp).toBeDefined();
    });

    it("accumulates transition history", () => {
      const db = createTestDb();
      recordTransition(db, "normal", "low_compute", 15000);
      recordTransition(db, "low_compute", "critical", 5000);

      const history = JSON.parse(db.getKV("tier_transitions") || "[]");
      expect(history).toHaveLength(2);
      expect(history[0].from).toBe("normal");
      expect(history[1].from).toBe("low_compute");
    });

    it("caps history at 50 entries", () => {
      const db = createTestDb();
      for (let i = 0; i < 60; i++) {
        recordTransition(db, "normal", "low_compute", i);
      }
      const history = JSON.parse(db.getKV("tier_transitions") || "[]");
      expect(history.length).toBeLessThanOrEqual(50);
    });
  });

  describe("Balance Formatting", () => {
    it("formats sats correctly", () => {
      const formatted = formatBalance(50000);
      expect(formatted).toContain("50");
      expect(formatted.toLowerCase()).toContain("sat");
    });

    it("formats zero balance", () => {
      const formatted = formatBalance(0);
      expect(formatted).toContain("0");
    });
  });
});
