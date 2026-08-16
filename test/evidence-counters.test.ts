import { describe, expect, test } from "vitest";
import { summarizeOpenCodeOutput, type JobKind, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";

function record(kind: JobKind = "run", overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_evidence",
    kind,
    status: "succeeded",
    cwd: "/tmp/workspace",
    command: "opencode",
    args: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    timeoutMs: 600_000,
    exitCode: 0,
    stdoutPath: "",
    stderrPath: "",
    ...overrides
  };
}

function toolCall(tool: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "tool_use", sessionID: "ses_evidence", part: { type: "tool", tool, state: { input } } });
}

function stream(lines: string[], verdict = "Findings: none."): string {
  return [
    JSON.stringify({ type: "step_start", sessionID: "ses_evidence" }),
    ...lines,
    JSON.stringify({ type: "text", sessionID: "ses_evidence", part: { type: "text", text: verdict } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_evidence", part: { type: "step-finish", reason: "stop" } })
  ].join("\n");
}

describe("evidence counters", () => {
  test("counts tool calls, distinct files, and turns", () => {
    const summary = summarizeOpenCodeOutput(
      record(),
      stream([
        toolCall("read", { filePath: "/repo/a.ts" }),
        toolCall("read", { filePath: "/repo/a.ts" }),
        toolCall("grep", { path: "/repo/b.ts" }),
        toolCall("bash", { command: "npm test" })
      ]),
      ""
    );

    expect(summary.toolCallCount).toBe(4);
    expect(summary.filesInspected).toBe(2);
    expect(summary.turnsUsed).toBe(1);
  });

  test("rates a verdict with no tool calls as no evidence", () => {
    const summary = summarizeOpenCodeOutput(record(), stream([]), "");

    expect(summary.toolCallCount).toBe(0);
    expect(summary.evidenceLevel).toBe("none");
  });

  test("separates a glance from an inspection", () => {
    const thin = summarizeOpenCodeOutput(record(), stream([toolCall("read", { filePath: "/repo/a.ts" })]), "");
    const substantive = summarizeOpenCodeOutput(
      record(),
      stream([
        toolCall("read", { filePath: "/repo/a.ts" }),
        toolCall("read", { filePath: "/repo/b.ts" }),
        toolCall("grep", { path: "/repo/c.ts" }),
        toolCall("bash", { command: "npm test" }),
        toolCall("read", { filePath: "/repo/d.ts" })
      ]),
      ""
    );

    expect(thin.evidenceLevel).toBe("thin");
    expect(substantive.evidenceLevel).toBe("substantive");
  });
});

describe("zero-evidence verdicts", () => {
  test("refuses to call a review with no tool calls a finished result", () => {
    // 30 of 64 succeeded sibling-plugin review jobs opened no file at all, and the
    // orchestrator counted each of them as one passing vote.
    for (const kind of ["review", "adversarial_review"] as const) {
      const summary = summarizeOpenCodeOutput(record(kind), stream([], "Verdict: GO."), "");

      expect(summary.resultComplete, kind).toBe(false);
      expect(summary.state, kind).toBe("succeeded_with_text");
      expect(summary.warnings.join(" "), kind).toMatch(/0 tool calls/);
      expect(summary.warnings.join(" "), kind).toMatch(/opinion, not review/);
      expect(summary.finalText, kind).toBe("Verdict: GO.");
    }
  });

  test("leaves a review that actually looked at something alone", () => {
    const summary = summarizeOpenCodeOutput(
      record("review"),
      stream([toolCall("read", { filePath: "/repo/a.ts" })], "Findings: one issue at a.ts:12."),
      ""
    );

    expect(summary.resultComplete).toBe(true);
    expect(summary.warnings.join(" ")).not.toMatch(/0 tool calls/);
  });

  test("does not apply the review rule to a run", () => {
    const summary = summarizeOpenCodeOutput(record("run"), stream([], "Done."), "");

    expect(summary.resultComplete).toBe(true);
  });
});

describe("skill loading", () => {
  test("names the interactive skills a headless delegation loaded", () => {
    // 89 of 231 recorded job logs opened a skill before doing the requested work.
    const summary = summarizeOpenCodeOutput(
      record(),
      stream([toolCall("skill", { name: "pua" }), toolCall("skill", { name: "pua" }), toolCall("read", { filePath: "/repo/a.ts" })]),
      ""
    );

    expect(summary.skillsLoaded).toEqual(["pua"]);
    expect(summary.warnings.join(" ")).toMatch(/loaded 1 skill/i);
    expect(summary.warnings.join(" ")).toMatch(/pua/);
  });

  test("says nothing when no skill was loaded", () => {
    const summary = summarizeOpenCodeOutput(record(), stream([toolCall("read", { filePath: "/repo/a.ts" })]), "");

    expect(summary.skillsLoaded).toEqual([]);
    expect(summary.warnings).toEqual([]);
  });
});
