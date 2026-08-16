import { z } from "zod";
import type { JobKind } from "./job-store.js";

/**
 * Wall-clock budget policy for OpenCode jobs.
 *
 * All constants below come from the 1,051 recorded jobs in
 * `~/.local/state/opencode-plugin-codex/jobs` between 2026-06-22 and 2026-08-15.
 * They will drift as models and machines change: re-measure before editing, and
 * keep the sample sizes next to the numbers so a later reader can tell how much
 * the numbers are worth.
 */
export const BUDGET_SAMPLE_WINDOW = "2026-06-22..2026-08-15";

/** Enforced by the background worker; the record keeps the effective value. */
export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Floor. Five calls used timeoutMs=1000 and all five timed out, while 30000ms
 * and 45000ms jobs did finish, so the floor sits below those successes.
 */
export const MIN_TIMEOUT_MS = 10_000;

export const MAX_TIMEOUT_MS = 86_400_000;

/**
 * Codex aborts a `tools/call` at 300s, so a foreground call cannot outlive it.
 * Requests above this are clamped (never refused) and reported in `warnings`.
 */
export const FOREGROUND_MAX_TIMEOUT_MS = 240_000;

/** p90 wall time per kind, and the number of jobs each p90 was computed from. */
export const KIND_P90_MS: Partial<Record<JobKind, number>> = {
  continue: 179_000,
  rescue: 283_000,
  run: 306_000,
  review: 347_000,
  adversarial_review: 370_000
};

export const KIND_P90_SAMPLE_SIZE: Partial<Record<JobKind, number>> = {
  continue: 290,
  rescue: 7,
  run: 154,
  review: 118,
  adversarial_review: 45
};

export const timeoutSchema = z
  .number()
  .int()
  .min(MIN_TIMEOUT_MS)
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(
    "Wall-clock budget in milliseconds, 10000..86400000. Default 600000 and that default is almost always correct: " +
      "at timeoutMs=600000 only 15 of 213 real jobs timed out (7%), at 900000 1 of 64, while at 120000 200 of 350 timed out (57%) " +
      "and at 180000 76 of 156 (49%). Lowering timeoutMs does not make OpenCode faster; it discards work. " +
      "Omit this field unless the user asked for a hard deadline. Foreground calls (background:false) are clamped to 240000 " +
      "because Codex aborts a tools/call at 300s; use background:true for a real budget."
  );

export type TimeoutBudget = {
  /** Budget actually handed to OpenCode after clamping. */
  timeoutMs: number;
  /** Advisory only. A budget is never refused because of these. */
  warnings: string[];
};

/**
 * Resolve the effective budget for one call. Warnings are advisory: a low budget
 * is a prediction of a timeout, not a reason to reject the caller's request.
 */
export function resolveTimeoutBudget(params: {
  kind: JobKind;
  background: boolean;
  requestedTimeoutMs?: number;
}): TimeoutBudget {
  const warnings: string[] = [];
  const requested = params.requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeoutMs = requested;

  if (!params.background && requested > FOREGROUND_MAX_TIMEOUT_MS) {
    timeoutMs = FOREGROUND_MAX_TIMEOUT_MS;
    const source = params.requestedTimeoutMs === undefined ? " (the default)" : "";
    warnings.push(
      `Foreground timeoutMs=${requested}${source} was clamped to ${FOREGROUND_MAX_TIMEOUT_MS} because Codex aborts a tools/call at 300s. ` +
        "Use background:true (the default for opencode_run) so the worker can enforce the full budget."
    );
  }

  const p90 = KIND_P90_MS[params.kind];
  const sampleSize = KIND_P90_SAMPLE_SIZE[params.kind];
  if (p90 !== undefined && timeoutMs < p90) {
    warnings.push(
      `timeoutMs=${timeoutMs} is below the p90 wall time for kind=${params.kind} (${p90}ms, n=${sampleSize}, ${BUDGET_SAMPLE_WINDOW}). ` +
        "Lowering timeoutMs does not make OpenCode faster; it discards work. Expect this job to hit the budget before OpenCode produces final text."
    );
  }

  return { timeoutMs, warnings };
}
