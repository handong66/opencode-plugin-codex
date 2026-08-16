import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore, summarizeOpenCodeOutput, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import { opencodeResult } from "../plugins/opencode-plugin-codex/src/tools.js";
import { readEnvelope } from "./helpers/envelope.js";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_final_text",
    // `run`, not `review`: a review with zero tool calls is deliberately not a
    // complete result (see test/evidence-counters.test.ts), and these cases are
    // about the answer field, not about evidence.
    kind: "run",
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

function stopStream(texts: string[], sessionId = "ses_final"): string {
  return [
    JSON.stringify({ type: "step_start", sessionID: sessionId }),
    ...texts.map((text) =>
      JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text } })
    ),
    JSON.stringify({ type: "step_finish", sessionID: sessionId, part: { type: "step-finish", reason: "stop" } })
  ].join("\n");
}

async function withStoredJob<T>(
  stdout: string,
  run: (params: { jobId: string; store: JobStore }) => Promise<T>
): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-final-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = "job_final_text_view";
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), stdout);
    await writeFile(store.stderrPath(jobId), "");
    await store.write(record({ id: jobId, stdoutPath: store.stdoutPath(jobId), stderrPath: store.stderrPath(jobId) }));
    return await run({ jobId, store });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("outputSummary.finalText", () => {
  test("returns the whole final answer, not a 500-character preview of it", () => {
    // Recorded final answers are median 4,226 and p90 8,784 characters; the preview
    // showed 2-12% of one and callers re-parsed the JSONL themselves to get the rest.
    const answer = `Findings: ${"a".repeat(4_000)} END`;
    const summary = summarizeOpenCodeOutput(record(), stopStream([answer]), "");

    expect(summary.resultComplete).toBe(true);
    expect(summary.finalText).toBe(answer);
    expect(summary.finalTextTruncated).toBe(false);
    expect((summary.lastTextPreview ?? "").length).toBeLessThanOrEqual(500);
  });

  test("bounds a runaway answer and says it did", () => {
    const answer = "x".repeat(40_000);
    const summary = summarizeOpenCodeOutput(record(), stopStream([answer]), "");

    expect(summary.finalText).toHaveLength(32_000);
    expect(summary.finalTextTruncated).toBe(true);
  });

  test("joins every text part of the final step", () => {
    // Hardening: no recorded log split one step across several text parts, but the
    // old code kept only the last part, so a split would have silently truncated.
    const summary = summarizeOpenCodeOutput(record(), stopStream(["Findings: ", "one", " and two"]), "");

    expect(summary.finalText).toBe("Findings: one and two");
  });

  test("is absent when OpenCode never produced a terminal answer", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_partial" }),
      JSON.stringify({ type: "text", sessionID: "ses_partial", part: { type: "text", text: "still working" } })
    ].join("\n");
    const summary = summarizeOpenCodeOutput(record({ status: "running" }), stdout, "");

    expect(summary.resultComplete).toBe(false);
    expect(summary.finalText).toBeUndefined();
    expect(summary.finalTextTruncated).toBe(false);
  });

  test("does not carry text from an earlier step that did not stop", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_two" }),
      JSON.stringify({ type: "text", sessionID: "ses_two", part: { type: "text", text: "interim thinking" } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_two",
        part: { type: "step-finish", reason: "tool-calls" }
      }),
      JSON.stringify({ type: "step_start", sessionID: "ses_two" }),
      JSON.stringify({ type: "text", sessionID: "ses_two", part: { type: "text", text: "the real answer" } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_two", part: { type: "step-finish", reason: "stop" } })
    ].join("\n");
    const summary = summarizeOpenCodeOutput(record(), stdout, "");

    expect(summary.finalText).toBe("the real answer");
  });
});

describe("opencode_result view", () => {
  test("keeps the raw tail by default", async () => {
    const answer = "Findings: the default view is unchanged.";
    await withStoredJob(stopStream([answer]), async ({ jobId }) => {
      const parsed = readEnvelope<{
        view?: string;
        stdout?: string;
        outputSummary?: { finalText?: string };
      }>(await opencodeResult({ jobId }));

      expect(parsed.view).toBe("raw");
      expect(parsed.stdout).toContain("step_finish");
      expect(parsed.outputSummary?.finalText).toBe(answer);
    });
  });

  test("drops the raw tails on request and keeps the answer", async () => {
    const answer = "Findings: the final view carries the answer.";
    await withStoredJob(stopStream([answer]), async ({ jobId }) => {
      const parsed = readEnvelope<{
        view?: string;
        stdout?: string;
        stderr?: string;
        rawOmitted?: boolean;
        outputSummary?: { finalText?: string };
      }>(await opencodeResult({ jobId, view: "final" }));

      expect(parsed.view).toBe("final");
      expect(parsed.rawOmitted).toBe(true);
      expect(parsed.stdout).toBeUndefined();
      expect(parsed.stderr).toBeUndefined();
      expect(parsed.outputSummary?.finalText).toBe(answer);
    });
  });
});
