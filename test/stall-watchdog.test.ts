import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  finalizeJobRecord,
  isProviderStall,
  readStreamProgress,
  STALL_MAX_STDOUT_CHARS,
  STALL_TIMEOUT_MS
} from "../plugins/opencode-plugin-codex/src/job-finalize.js";
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

/** The worker's own accounting: complete lines only, counted as they stream in. */
function observedToolCalls(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .reduce((total, line) => total + readStreamProgress(line).toolCalls, 0);
}

describe("the watchdog's kill rule", () => {
  test("kills a run that has emitted nothing and called no tool", () => {
    // The recorded shape: a 304-byte stdout holding one step_start, then silence.
    const stdout = JSON.stringify({ type: "step_start", sessionID: "ses_stall" });

    expect(
      isProviderStall({
        silentMs: STALL_TIMEOUT_MS,
        stdoutChars: stdout.length,
        toolCalls: observedToolCalls(stdout)
      })
    ).toBe(true);
  });

  test("leaves a slow first tool call alone, however long it is silent", () => {
    // A first tool call that is a build or a test run: almost no stdout, no further
    // events for minutes, and a perfectly good result at the end. The old predicate
    // read only silence and stdout size, so it SIGTERMed this run at 45s and filed
    // it as `stalled` — with guidance saying a larger timeoutMs would not help.
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_build" }),
      JSON.stringify({ type: "tool_use", sessionID: "ses_build", part: { type: "tool", tool: "bash" } })
    ].join("\n");
    const toolCalls = observedToolCalls(stdout);

    expect(toolCalls).toBe(1);
    expect(stdout.length).toBeLessThan(STALL_MAX_STDOUT_CHARS);
    expect(isProviderStall({ silentMs: 8 * STALL_TIMEOUT_MS, stdoutChars: stdout.length, toolCalls })).toBe(
      false
    );

    // …and the run the watchdog no longer kills finishes normally.
    const finished = [
      stdout,
      JSON.stringify({ type: "text", part: { type: "text", text: "build passed" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step_finish", reason: "stop" } })
    ].join("\n");
    const record = finalizeJobRecord({
      record: runningRecord(),
      stdout: finished,
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("succeeded");
    expect(record.errorClass).toBeUndefined();
  });

  test("still leaves a run alone once real output is flowing", () => {
    expect(
      isProviderStall({ silentMs: 10 * STALL_TIMEOUT_MS, stdoutChars: STALL_MAX_STDOUT_CHARS, toolCalls: 0 })
    ).toBe(false);
  });

  test("does not fire before the silence window", () => {
    expect(isProviderStall({ silentMs: STALL_TIMEOUT_MS - 1, stdoutChars: 10, toolCalls: 0 })).toBe(false);
  });
});

describe("the worker feeds the rule the numbers it needs", () => {
  // job-worker.ts is an executable (top-level `await main()`), so the wiring is
  // asserted at source level: the counter used to be maintained only when the job
  // carried a maxToolCalls ceiling, which is what left the watchdog unable to tell a
  // hang from a slow first tool call.
  test("counts tool calls for every job, not only budgeted ones", async () => {
    const source = await readFile(
      join(process.cwd(), "plugins/opencode-plugin-codex/src/job-worker.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/if \(!record\.maxToolCalls\) return;/);
    expect(source).toContain("isProviderStall({ silentMs, stdoutChars: stdout.length, toolCalls: toolCallCount })");
  });
});

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
