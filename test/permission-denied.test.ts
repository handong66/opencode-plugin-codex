import { describe, expect, test } from "vitest";
import { summarizeOpenCodeOutput, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";

function succeededRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_permission_probe",
    kind: "review",
    status: "succeeded",
    cwd: "/Users/probe/repo/.worktrees/feature",
    command: "opencode",
    args: ["run", "--format", "json"],
    createdAt: "2026-08-14T00:00:00.000Z",
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:02:00.000Z",
    timeoutMs: 600_000,
    exitCode: 0,
    stdoutPath: "",
    stderrPath: "",
    ...overrides
  };
}

/** Verbatim shape of the auto-rejection lines in the six recorded jobs. */
const AUTO_REJECT_STDERR = [
  "permission requested: bash (/private/tmp/probe-1); auto-rejecting",
  "permission requested: read (/Users/probe/repo/.venv/bin/python); auto-rejecting",
  "permission requested: read (/Users/probe/.config/git/config); auto-rejecting"
].join("\n");

const TOOL_ONLY_STDOUT = [
  JSON.stringify({ type: "step_start", sessionID: "ses_denied" }),
  JSON.stringify({ type: "tool_use", sessionID: "ses_denied", part: { type: "tool", tool: "read" } }),
  JSON.stringify({ type: "step_finish", sessionID: "ses_denied", part: { type: "step-finish", reason: "stop" } })
].join("\n");

describe("permission auto-rejection", () => {
  test("reports the denied tool calls instead of an empty finding set", () => {
    const summary = summarizeOpenCodeOutput(succeededRecord(), TOOL_ONLY_STDOUT, AUTO_REJECT_STDERR);

    expect(summary.permissionDenied).toBe(true);
    expect(summary.deniedPaths).toEqual([
      "/private/tmp/probe-1",
      "/Users/probe/repo/.venv/bin/python",
      "/Users/probe/.config/git/config"
    ]);
  });

  test("bounds the reported paths", () => {
    const stderr = Array.from(
      { length: 9 },
      (_unused, index) => `permission requested: read (/private/tmp/probe-${index}); auto-rejecting`
    ).join("\n");

    const summary = summarizeOpenCodeOutput(succeededRecord(), TOOL_ONLY_STDOUT, stderr);

    expect(summary.deniedPaths).toHaveLength(5);
  });

  test("also catches the structured tool-state rejection", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_state" }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_state",
        part: {
          type: "tool",
          tool: "read",
          state: {
            error: "The user rejected permission to use this specific tool call.",
            input: { filePath: "/private/tmp/rejected-by-state" }
          }
        }
      })
    ].join("\n");

    const summary = summarizeOpenCodeOutput(succeededRecord(), stdout, "");

    expect(summary.permissionDenied).toBe(true);
    expect(summary.deniedPaths).toContain("/private/tmp/rejected-by-state");
  });

  test("says absence of findings is not evidence, and offers cwd before --auto", () => {
    // All six recorded cases ran with a cwd narrower than the paths they needed; five
    // of them only needed a wider cwd, not wider permissions.
    const summary = summarizeOpenCodeOutput(succeededRecord(), TOOL_ONLY_STDOUT, AUTO_REJECT_STDERR);

    expect(summary.guidance).toContain("was denied 3 permission");
    expect(summary.guidance).toContain("/private/tmp/probe-1");
    expect(summary.guidance).toMatch(/NOT evidence of correctness/);
    const cwdAdvice = summary.guidance.indexOf("cwd");
    const autoAdvice = summary.guidance.indexOf("autoApprovePermissions");
    expect(cwdAdvice).toBeGreaterThanOrEqual(0);
    expect(autoAdvice).toBeGreaterThan(cwdAdvice);
    expect(summary.guidance).toMatch(/read-only review/);
    expect(summary.guidance).not.toMatch(/narrower target/);
  });

  test("leaves a clean job alone", () => {
    const summary = summarizeOpenCodeOutput(succeededRecord(), TOOL_ONLY_STDOUT, "");

    expect(summary.permissionDenied).toBe(false);
    expect(summary.deniedPaths).toEqual([]);
    expect(summary.guidance).toMatch(/narrower target/);
  });

  test("keeps the denial visible on a job that did produce final text", () => {
    // kind `run`: a review with zero tool calls is separately not a complete result.
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_text" }),
      JSON.stringify({ type: "text", sessionID: "ses_text", part: { type: "text", text: "No issues found." } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_text", part: { type: "step-finish", reason: "stop" } })
    ].join("\n");

    const summary = summarizeOpenCodeOutput(succeededRecord({ kind: "run" }), stdout, AUTO_REJECT_STDERR);

    expect(summary.resultComplete).toBe(true);
    expect(summary.permissionDenied).toBe(true);
    expect(summary.guidance).toMatch(/denied 3 permission/);
  });
});
