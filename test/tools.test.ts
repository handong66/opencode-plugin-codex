import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { opencodeAdversarialReview, opencodeResult, opencodeRun } from "../plugins/opencode-plugin-codex/src/tools.js";

function parseToolResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    ok: boolean;
    exitCode?: number | null;
    stdout?: string;
    outputSummary?: {
      resultComplete: boolean;
      state: string;
      eventCounts: Record<string, number>;
      sawSubagentTask: boolean;
      guidance: string;
    };
  };
}

async function withTempJob<T>(
  record: Record<string, unknown>,
  stdout: string,
  stderr: string,
  run: (params: { cwd: string; jobId: string }) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-test-"));
  try {
    const jobsDir = join(cwd, ".opencode-plugin-codex", "jobs");
    await mkdir(jobsDir, { recursive: true });
    const jobId = String(record.id);
    const stdoutPath = join(jobsDir, `${jobId}.stdout.log`);
    const stderrPath = join(jobsDir, `${jobId}.stderr.log`);
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    await writeFile(
      join(jobsDir, `${jobId}.json`),
      `${JSON.stringify(
        {
          kind: "review",
          cwd,
          command: "opencode",
          args: [],
          createdAt: "2026-07-06T00:00:00.000Z",
          stdoutPath,
          stderrPath,
          ...record
        },
        null,
        2
      )}\n`
    );
    return await run({ cwd, jobId });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("opencodeRun", () => {
  test("passes long prompt text as the run message instead of a file path", async () => {
    const prompt = `LONG_PROMPT_${"x".repeat(5_000)}`;

    const result = parseToolResult(
      await opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt
      })
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(prompt);
    expect(result.stdout).not.toContain("--file");
  });

  test("puts the message before file attachments so OpenCode does not parse it as a file", async () => {
    const result = parseToolResult(
      await opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt: "review this file",
        files: ["README.md"]
      })
    );

    expect(result.ok).toBe(true);
    const stdout = result.stdout ?? "";
    expect(stdout).toContain("review this file");
    expect(stdout).toContain("--file README.md");
    expect(stdout.indexOf("review this file")).toBeLessThan(stdout.indexOf("--file README.md"));
  });

  test("rejects prompt-like text passed through files before OpenCode treats it as a path", async () => {
    const promptLikeFile = [
      "Review the implementation below and find the bug.",
      "",
      "This is not a filesystem path; it is task text that belongs in prompt.",
      "x".repeat(300)
    ].join("\n");

    await expect(
      opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt: "review this",
        files: [promptLikeFile]
      })
    ).rejects.toThrow(/files.*filesystem paths.*prompt/i);
  });

  test("rejects prompts that ask OpenCode to read Codex private runtime paths by default", async () => {
    await expect(
      opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        prompt: "Before reviewing, read /Users/example/.codex/pua/skills/pua/SKILL.md and follow it."
      })
    ).rejects.toThrow(/Codex private runtime paths/i);
  });

  test("allows Codex private runtime paths only when broader OpenCode permissions are explicit", async () => {
    const result = parseToolResult(
      await opencodeRun({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        dangerouslySkipPermissions: true,
        prompt: "Read ~/.codex/pua/skills/pua/SKILL.md only because broader OpenCode access was explicitly granted."
      })
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("--dangerously-skip-permissions");
  });
});

describe("opencodeAdversarialReview", () => {
  test("keeps security/path boundary reviews bounded and prevents security scan escalation", async () => {
    const result = parseToolResult(
      await opencodeAdversarialReview({
        opencodeBin: "/bin/echo",
        cwd: process.cwd(),
        background: false,
        target: "security/path boundary changes in plugins/opencode-plugin-codex/src/tools.ts"
      })
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("bounded failure-mode review");
    expect(result.stdout).toContain("Do not invoke security scan skills");
    expect(result.stdout).toContain("security-diff-scan");
    expect(result.stdout).toContain("Do not spawn subagents for this bounded review");
    expect(result.stdout).toContain("separate explicitly scoped OpenCode task");
  });
});

describe("opencodeResult", () => {
  test("marks cancelled tool-only background logs as partial, not final output", async () => {
    const jobId = "job_cancelled_partial";
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_partial" }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_partial",
        part: { type: "tool", tool: "read" }
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_partial",
        part: { type: "tool", tool: "task" }
      }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_partial" })
    ].join("\n");

    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "cancelled" }, stdout, "", ({ cwd }) =>
        opencodeResult({ cwd, jobId })
      )
    );

    expect(result.ok).toBe(true);
    expect(result.outputSummary?.resultComplete).toBe(false);
    expect(result.outputSummary?.state).toBe("cancelled_partial");
    expect(result.outputSummary?.eventCounts.tool_use).toBe(2);
    expect(result.outputSummary?.sawSubagentTask).toBe(true);
    expect(result.outputSummary?.guidance).toMatch(/partial logs only/i);
  });

  test("marks succeeded OpenCode jobs with assistant text as complete", async () => {
    const jobId = "job_succeeded_text";
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_complete" }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_complete",
        part: { type: "text", text: "Findings: no blocking issues." }
      }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_complete" })
    ].join("\n");

    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded" }, stdout, "", ({ cwd }) =>
        opencodeResult({ cwd, jobId })
      )
    );

    expect(result.ok).toBe(true);
    expect(result.outputSummary?.resultComplete).toBe(true);
    expect(result.outputSummary?.state).toBe("succeeded_with_text");
    expect(result.outputSummary?.guidance).toMatch(/Codex must still verify/i);
  });
});
