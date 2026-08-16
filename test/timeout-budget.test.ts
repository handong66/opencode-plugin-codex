import { describe, expect, test } from "vitest";
import {
  DEFAULT_TIMEOUT_MS,
  FOREGROUND_MAX_TIMEOUT_MS,
  KIND_P90_MS,
  resolveTimeoutBudget,
  timeoutSchema
} from "../plugins/opencode-plugin-codex/src/timeout-budget.js";

describe("timeoutSchema", () => {
  test("rejects budgets below the observed floor", () => {
    // The five recorded timeoutMs=1000 calls could never finish an OpenCode job.
    expect(timeoutSchema.safeParse(1_000).success).toBe(false);
    expect(timeoutSchema.safeParse(9_999).success).toBe(false);
  });

  test("keeps the short budgets that actually succeeded", () => {
    // job_1786547639263_135155be (45000ms) and two 30000ms jobs succeeded;
    // a 60000ms floor would have rejected them.
    for (const value of [10_000, 30_000, 45_000]) {
      expect(timeoutSchema.safeParse(value).success).toBe(true);
    }
  });

  test("keeps the 24h ceiling and rejects non-integers", () => {
    expect(timeoutSchema.safeParse(86_400_000).success).toBe(true);
    expect(timeoutSchema.safeParse(86_400_001).success).toBe(false);
    expect(timeoutSchema.safeParse(60_000.5).success).toBe(false);
  });

  test("is optional and documents the default budget", () => {
    expect(timeoutSchema.safeParse(undefined).success).toBe(true);
    const described = timeoutSchema.description ?? "";
    expect(described).toContain("600000");
    expect(described).toMatch(/does not make OpenCode faster/i);
    expect(described).toMatch(/10000/);
  });
});

describe("resolveTimeoutBudget", () => {
  test("leaves an omitted background budget at the default and stays silent", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: true });

    expect(budget.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(budget.warnings).toEqual([]);
  });

  test("warns without rejecting when a background budget is under the kind p90", () => {
    const budget = resolveTimeoutBudget({ kind: "review", background: true, requestedTimeoutMs: 120_000 });

    expect(budget.timeoutMs).toBe(120_000);
    expect(budget.warnings).toHaveLength(1);
    expect(budget.warnings[0]).toContain("120000");
    expect(budget.warnings[0]).toContain(String(KIND_P90_MS.review));
    expect(budget.warnings[0]).toMatch(/review/);
  });

  test("does not warn when the background budget clears the kind p90", () => {
    const budget = resolveTimeoutBudget({ kind: "continue", background: true, requestedTimeoutMs: 180_000 });

    expect(budget.timeoutMs).toBe(180_000);
    expect(budget.warnings).toEqual([]);
  });

  test("has no p90 opinion for kinds without a recorded sample", () => {
    const budget = resolveTimeoutBudget({ kind: "transfer", background: true, requestedTimeoutMs: 15_000 });

    expect(budget.timeoutMs).toBe(15_000);
    expect(budget.warnings).toEqual([]);
  });

  test("clamps the foreground default to the Codex tools/call ceiling and says so", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: false });

    expect(budget.timeoutMs).toBe(FOREGROUND_MAX_TIMEOUT_MS);
    const clampWarning = budget.warnings.find((warning) => warning.includes("240000"));
    expect(clampWarning).toBeDefined();
    expect(clampWarning).toMatch(/background/);
  });

  test("clamps an explicit oversized foreground budget instead of refusing the call", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: false, requestedTimeoutMs: 900_000 });

    expect(budget.timeoutMs).toBe(FOREGROUND_MAX_TIMEOUT_MS);
    expect(budget.warnings.some((warning) => warning.includes("900000"))).toBe(true);
  });

  test("leaves a small foreground budget alone but still reports the p90 gap", () => {
    const budget = resolveTimeoutBudget({
      kind: "adversarial_review",
      background: false,
      requestedTimeoutMs: 60_000
    });

    expect(budget.timeoutMs).toBe(60_000);
    expect(budget.warnings.some((warning) => warning.includes("240000"))).toBe(false);
    expect(budget.warnings.some((warning) => warning.includes(String(KIND_P90_MS.adversarial_review)))).toBe(true);
  });

  test("carries the sample size and window so the constants can be re-measured", () => {
    const budget = resolveTimeoutBudget({ kind: "run", background: true, requestedTimeoutMs: 120_000 });

    expect(budget.warnings[0]).toMatch(/n=\d+/);
    expect(budget.warnings[0]).toContain("2026-08-15");
  });
});
