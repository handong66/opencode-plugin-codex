import { describe, expect, test } from "vitest";
import { finalizeJobRecord } from "../plugins/opencode-plugin-codex/src/job-finalize.js";
import { summarizeOpenCodeOutput, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import { isRetryableOpenCodeFailure } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";

function runningRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_stall",
    kind: "run",
    status: "running",
    cwd: "/workspace",
    command: "opencode",
    args: ["run", "--format", "json"],
    createdAt: "2026-08-16T00:00:00.000Z",
    startedAt: "2026-08-16T00:00:00.000Z",
    timeoutMs: 600_000,
    stdoutPath: "",
    stderrPath: "",
    ...overrides
  };
}

describe("no-progress watchdog", () => {
  test("a silent run with nothing to show is stalled, not timed out", () => {
    // The recorded shape: a 304-byte stdout holding one step_start, then silence.
    const stdout = JSON.stringify({ type: "step_start", sessionID: "ses_stall" });

    const record = finalizeJobRecord({
      record: runningRecord(),
      stdout,
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: false,
      stalled: { silentMs: 45_000 },
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("stalled");
    // Worth another attempt — with a different model, not a bigger budget.
    expect(isRetryableOpenCodeFailure(record.errorClass)).toBe(true);
    expect(record.errorMessage).toContain("45s");
    expect(record.errorMessage).toContain("provider or model hang");
    // The session handle is still recovered, so the caller can inspect it.
    expect(record.opencodeSessionId).toBe("ses_stall");
    expect(record.resumable).toBe(true);
  });

  test("a real timeout still wins over a stall flag", () => {
    const record = finalizeJobRecord({
      record: runningRecord(),
      stdout: "",
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      stalled: { silentMs: 45_000 },
      cancelRequested: false
    });

    expect(record.errorClass).toBe("timeout");
  });

  test("a cancellation still wins over both", () => {
    const record = finalizeJobRecord({
      record: runningRecord(),
      stdout: "",
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: false,
      stalled: { silentMs: 45_000 },
      cancelRequested: true
    });

    expect(record.status).toBe("cancelled");
    expect(record.errorClass).toBeUndefined();
  });

  test("guidance sends a stalled job to the provider, not to a larger budget", () => {
    const summary = summarizeOpenCodeOutput(
      runningRecord({ status: "failed", errorClass: "stalled" }),
      JSON.stringify({ type: "step_start", sessionID: "ses_stall" }),
      ""
    );

    expect(summary.guidance).toMatch(/lighter explicit model/i);
    expect(summary.guidance).toMatch(/PROXY/);
    // Explicitly the opposite of the timeout advice, which is to raise the budget.
    expect(summary.guidance).toMatch(/larger timeoutMs will not help/i);
    expect(summary.guidance).not.toContain("opencode_continue{sessionId");
  });
});
