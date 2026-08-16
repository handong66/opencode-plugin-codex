import { describe, expect, test } from "vitest";
import { finalizeJobRecord } from "../plugins/opencode-plugin-codex/src/job-finalize.js";
import type { JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";

function baseRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_finalize_probe",
    kind: "run",
    status: "running",
    cwd: "/tmp/workspace",
    command: "opencode",
    args: ["run", "--format", "json"],
    createdAt: "2026-08-15T00:00:00.000Z",
    startedAt: "2026-08-15T00:00:00.000Z",
    timeoutMs: 120_000,
    stdoutPath: "/tmp/workspace/job.stdout.log",
    stderrPath: "/tmp/workspace/job.stderr.log",
    ...overrides
  };
}

/** Shape of a real OpenCode --format json stream: the session id is in event one. */
function stream(sessionId: string | undefined, events: number): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "step_start", ...(sessionId ? { sessionID: sessionId } : {}) }));
  for (let index = 1; index < events; index += 1) {
    lines.push(
      JSON.stringify({
        type: "tool_use",
        ...(sessionId ? { sessionID: sessionId } : {}),
        part: { type: "tool", tool: "read" }
      })
    );
  }
  return lines.join("\n");
}

describe("finalizeJobRecord on timeout", () => {
  test("recovers the OpenCode session id from the stream the job already produced", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_timeout_handle", 7),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("timeout");
    expect(record.opencodeSessionId).toBe("ses_timeout_handle");
    expect(record.resumable).toBe(true);
  });

  test("says how much work the budget threw away and that the session survives", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_timeout_handle", 7),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      cancelRequested: false
    });

    expect(record.errorMessage).toBe(
      "OpenCode exceeded timeoutMs=120000 after producing 7 events. The OpenCode session ses_timeout_handle is still resumable."
    );
  });

  test("does not promise a resume handle it never saw", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream(undefined, 2),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      cancelRequested: false
    });

    expect(record.resumable).toBe(false);
    expect(record.opencodeSessionId).toBeUndefined();
    expect(record.errorMessage).toContain("timeoutMs=120000");
    expect(record.errorMessage).toMatch(/no OpenCode session id/i);
    expect(record.errorMessage).not.toMatch(/is still resumable/);
  });

  test("keeps a session id the caller already supplied", () => {
    const record = finalizeJobRecord({
      record: baseRecord({ kind: "continue", opencodeSessionId: "ses_from_caller" }),
      stdout: stream("ses_from_stream", 3),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      cancelRequested: false
    });

    expect(record.opencodeSessionId).toBe("ses_from_caller");
    expect(record.errorMessage).toContain("ses_from_caller");
  });
});

describe("finalizeJobRecord on other outcomes", () => {
  test("records the session id of a successful job too", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_success", 4),
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("succeeded");
    expect(record.opencodeSessionId).toBe("ses_success");
    expect(record.resumable).toBeUndefined();
    expect(record.errorClass).toBeUndefined();
  });

  test("keeps cancellation ahead of every failure branch", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_cancelled", 2),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: true,
      cancelRequested: true
    });

    expect(record.status).toBe("cancelled");
    expect(record.errorClass).toBeUndefined();
    expect(record.opencodeSessionId).toBe("ses_cancelled");
  });

  test("keeps a structured JSONL error class and still recovers the handle", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_api_error" }),
      JSON.stringify({
        type: "error",
        sessionID: "ses_api_error",
        error: { name: "APIError", data: { message: "403 Forbidden: model not authorized" } }
      })
    ].join("\n");

    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout,
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("model_unauthorized");
    expect(record.opencodeSessionId).toBe("ses_api_error");
  });

  test("classifies a nonzero exit through the existing classifier and keeps the handle", () => {
    // Narrowing this classifier is OC-3 (batch 2); OC-2 only has to not lose the handle.
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_failed", 2),
      stderr: "opencode: something broke\n",
      outcome: { exitCode: 1, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("opencode_failed");
    expect(record.opencodeSessionId).toBe("ses_failed");
    expect(record.resumable).toBeUndefined();
  });

  test("never leaves a failed job without an errorMessage", () => {
    const withStderr = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_failed", 2),
      stderr: "opencode: something broke\n",
      outcome: { exitCode: 1, signal: null },
      timedOut: false,
      cancelRequested: false
    });
    const withoutStderr = finalizeJobRecord({
      record: baseRecord(),
      stdout: stream("ses_silent", 2),
      stderr: "",
      outcome: { exitCode: 7, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(withStderr.errorMessage).toContain("exited with code 1");
    expect(withStderr.errorMessage).toContain("something broke");
    expect(withoutStderr.errorMessage).toContain("exited with code 7");
    expect(withoutStderr.errorMessage).toBeTruthy();
  });

  test("reports an externally killed job as terminated, not as an authorization failure", () => {
    // exitCode is null when something else SIGTERMs OpenCode; the old path handed the
    // whole stdout transcript to a keyword classifier and invented a verdict from it.
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: [
        stream("ses_killed", 2),
        JSON.stringify({ type: "text", part: { type: "text", text: "the endpoint returns 403 Forbidden" } })
      ].join("\n"),
      stderr: "",
      outcome: { exitCode: null, signal: "SIGTERM" },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.errorClass).toBe("terminated");
    expect(record.errorMessage).toContain("SIGTERM");
  });

  test("reports a provider quota failure as its own non-retryable class", () => {
    const record = finalizeJobRecord({
      record: baseRecord(),
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses_quota" }),
        JSON.stringify({
          type: "error",
          error: { name: "APIError", data: { message: "balance exhausted", statusCode: 402 } }
        })
      ].join("\n"),
      stderr: "",
      outcome: { exitCode: 1, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.errorClass).toBe("quota_exhausted");
    expect(record.errorMessage).toBe("balance exhausted");
    expect(record.opencodeSessionId).toBe("ses_quota");
  });

  test("reports a spawn or stdin failure with its own class", () => {
    const spawnFailure = finalizeJobRecord({
      record: baseRecord(),
      stdout: "",
      stderr: "",
      outcome: { exitCode: null, signal: null, error: new Error("spawn ENOENT") },
      timedOut: false,
      cancelRequested: false
    });
    const stdinFailure = finalizeJobRecord({
      record: baseRecord(),
      stdout: "",
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false,
      stdinError: new Error("OpenCode stdin closed before the prompt was flushed.")
    });

    expect(spawnFailure.errorClass).toBe("spawn_error");
    expect(spawnFailure.errorMessage).toContain("spawn ENOENT");
    expect(stdinFailure.errorClass).toBe("stdin_error");
    expect(stdinFailure.errorMessage).toContain("stdin");
  });
});

describe("terminal summary persistence", () => {
  test("keeps the answer, the evidence counters and the denial flag on the record", () => {
    // 231 of 1,051 recorded jobs still had stdout, all from one six-day window: the
    // other 78% have a record and nothing to read.
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_persist" }),
      JSON.stringify({
        type: "tool_use",
        part: { type: "tool", tool: "read", state: { input: { filePath: "src/a.ts" } } }
      }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Findings: one real bug in src/a.ts:12." } }),
      JSON.stringify({ type: "step_finish", part: { type: "step_finish", reason: "stop" } })
    ].join("\n");

    const record = finalizeJobRecord({
      record: baseRecord({ status: "running" }),
      stdout,
      stderr: "permission requested: read (/private/tmp/x); auto-rejecting",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("succeeded");
    expect(record.terminalSummary?.state).toBe("succeeded_with_text");
    expect(record.terminalSummary?.finalTextPreview).toBe("Findings: one real bug in src/a.ts:12.");
    expect(record.terminalSummary?.toolCallCount).toBe(1);
    expect(record.terminalSummary?.filesInspected).toBe(1);
    expect(record.terminalSummary?.permissionDenied).toBe(true);
    expect(record.terminalSummary?.deniedPaths).toEqual(["/private/tmp/x"]);
    expect(record.opencodeSessionId).toBe("ses_persist");
  });

  test("bounds the persisted answer so records stay small", () => {
    const answer = "z".repeat(9_000);
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_big" }),
      JSON.stringify({ type: "text", part: { type: "text", text: answer } }),
      JSON.stringify({ type: "step_finish", part: { type: "step_finish", reason: "stop" } })
    ].join("\n");

    const record = finalizeJobRecord({
      record: baseRecord({ status: "running" }),
      stdout,
      stderr: "",
      outcome: { exitCode: 0, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.terminalSummary?.finalTextPreview).toHaveLength(4_000);
    expect(record.terminalSummary?.finalTextTruncated).toBe(true);
  });

  test("records the terminal state of a failure too", () => {
    const record = finalizeJobRecord({
      record: baseRecord({ status: "running" }),
      stdout: JSON.stringify({ type: "step_start", sessionID: "ses_fail" }),
      stderr: "boom",
      outcome: { exitCode: 1, signal: null },
      timedOut: false,
      cancelRequested: false
    });

    expect(record.status).toBe("failed");
    expect(record.terminalSummary?.state).toBe("failed_partial");
    expect(record.terminalSummary?.resultComplete).toBe(false);
    expect(record.terminalSummary?.evidenceLevel).toBe("none");
  });
});
