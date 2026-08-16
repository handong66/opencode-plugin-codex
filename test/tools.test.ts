import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore } from "../plugins/opencode-plugin-codex/src/job-store.js";
import {
  opencodeAdversarialReview,
  opencodeContinue,
  opencodeRescue,
  opencodeResult,
  opencodeReview,
  opencodeRun,
  opencodeStatus,
  opencodeTransfer
} from "../plugins/opencode-plugin-codex/src/tools.js";
import { readEnvelope, refusalOf } from "./helpers/envelope.js";

/**
 * Read the structured object, not `content[0].text`: a payload over 8KB is returned
 * once, as structuredContent, and is deliberately not duplicated as text.
 */
function parseToolResult(result: { structuredContent: unknown }) {
  return readEnvelope<{
    ok: boolean;
    exitCode?: number | null;
    stdout?: string;
    warnings?: string[];
    maxChars?: number;
    maxCharsClamped?: boolean;
    openCodeSessionId?: string;
    resumable?: boolean;
    record?: { timeoutMs?: number; opencodeSessionId?: string; resumable?: boolean };
    outputSummary?: {
      resultComplete: boolean;
      state: string;
      eventCounts: Record<string, number>;
      sawSubagentTask: boolean;
      toolCallCount?: number;
      evidenceLevel?: string;
      warnings?: string[];
      errorClass?: string;
      guidance: string;
    };
  }>(result);
}

async function withTempJob<T>(
  record: Record<string, unknown>,
  stdout: string,
  stderr: string,
  run: (params: { jobId: string }) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-test-"));
  const previousStateDir = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = cwd;
    const store = new JobStore(cwd);
    const jobId = String(record.id);
    const stdoutPath = store.stdoutPath(jobId);
    const stderrPath = store.stderrPath(jobId);
    await store.ensure();
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    await store.write({
      id: jobId,
      kind: "review",
      status: "running",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-07-06T00:00:00.000Z",
      timeoutMs: 60_000,
      stdoutPath,
      stderrPath,
      ...record
    });
    return await run({ jobId });
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previousStateDir;
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * A detached background worker keeps writing into the state directory after the
 * tool call returns, so a plain rm races it and fails with ENOTEMPTY. Retry until
 * the worker is done rather than sleeping a fixed amount and hoping.
 */
async function removeWhenQuiet(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

async function createFakeOpenCode(cwd: string): Promise<string> {
  const bin = join(cwd, "fake-opencode.mjs");
  await writeFile(
    bin,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), input, codexEnv: Object.keys(process.env).filter((name) => name.startsWith('CODEX_')) })));"
    ].join("\n")
  );
  await chmod(bin, 0o755);
  return bin;
}

async function withFakeOpenCode<T>(run: () => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-fake-bin-"));
  const previous = process.env.OPENCODE_BIN;
  try {
    process.env.OPENCODE_BIN = await createFakeOpenCode(binDir);
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
    await rm(binDir, { recursive: true, force: true });
  }
}

describe("opencodeRun", () => {
  test("sends the prompt through stdin instead of a positional argument", async () => {
    await withFakeOpenCode(async () => {
      const prompt = "Review these two words without adding literal quotes.";

      const result = parseToolResult(await opencodeRun({ cwd: process.cwd(), background: false, prompt }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[]; input: string };

      expect(invocation.input).toBe(prompt);
      expect(invocation.args).not.toContain(prompt);
    });
  });

  test("returns a non-final output summary for foreground runs without terminal assistant text", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeRun({ cwd: process.cwd(), background: false, prompt: "foreground summary probe" })
      );

      expect(result.ok).toBe(true);
      expect(result.outputSummary?.resultComplete).toBe(false);
      expect(result.outputSummary?.state).toBe("succeeded_without_text");
    });
  });

  test("does not expose CODEX_* runtime variables to foreground OpenCode", async () => {
    const previous = process.env.CODEX_TEST_SECRET_SENTINEL;
    process.env.CODEX_TEST_SECRET_SENTINEL = "must-not-leak";
    try {
      await withFakeOpenCode(async () => {
        const result = parseToolResult(
          await opencodeRun({ cwd: process.cwd(), background: false, prompt: "environment probe" })
        );
        const invocation = JSON.parse((result.stdout ?? "").trim()) as { codexEnv: string[] };

        expect(invocation.codexEnv).not.toContain("CODEX_TEST_SECRET_SENTINEL");
      });
    } finally {
      if (previous === undefined) delete process.env.CODEX_TEST_SECRET_SENTINEL;
      else process.env.CODEX_TEST_SECRET_SENTINEL = previous;
    }
  });

  test("passes long prompt text as the run message instead of a file path", async () => {
    const prompt = `LONG_PROMPT_${"x".repeat(5_000)}`;

    await withFakeOpenCode(async () => {
      const result = parseToolResult(await opencodeRun({
        cwd: process.cwd(),
        background: false,
        prompt
      }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[]; input: string };

      expect(result.ok).toBe(true);
      expect(invocation.input).toBe(prompt);
      expect(invocation.args).not.toContain("--file");
    });
  });

  test("keeps the message on stdin while passing file attachments as flags", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(await opencodeRun({
        cwd: process.cwd(),
        background: false,
        prompt: "review this file",
        files: ["README.md"]
      }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[]; input: string };

      expect(result.ok).toBe(true);
      expect(invocation.input).toBe("review this file");
      expect(invocation.args).toContain("--file");
      expect(invocation.args).toContain("README.md");
      expect(invocation.args).not.toContain("review this file");
    });
  });

  test("rejects prompt-like text passed through files before OpenCode treats it as a path", async () => {
    const promptLikeFile = [
      "Review the implementation below and find the bug.",
      "",
      "This is not a filesystem path; it is task text that belongs in prompt.",
      "x".repeat(300)
    ].join("\n");

    const error = await refusalOf(() =>
      opencodeRun({
        cwd: process.cwd(),
        background: false,
        prompt: "review this",
        files: [promptLikeFile]
      })
    );

    expect(error.code).toBe("file_attachment_invalid");
    expect(error.message).toMatch(/files.*filesystem paths.*prompt/i);
  });

  test("rejects file attachments outside the active workspace", async () => {
    const error = await refusalOf(() =>
      opencodeRun({
        cwd: process.cwd(),
        background: false,
        prompt: "review the attachment",
        files: ["/etc/hosts"]
      })
    );

    expect(error.code).toBe("file_attachment_invalid");
    expect(error.message).toMatch(/outside.*workspace/i);
  });

  test("rejects workspace symlinks whose targets escape the workspace", async () => {
    const temp = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-symlink-"));
    try {
      const link = join(temp, "outside-hosts");
      await symlink("/etc/hosts", link);
      const error = await refusalOf(() =>
        opencodeRun({
          cwd: process.cwd(),
          background: false,
          prompt: "review the symlink",
          files: [link]
        })
      );

      expect(error.code).toBe("file_attachment_invalid");
      expect(error.message).toMatch(/outside.*workspace/i);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test("rejects working directories outside the MCP workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-outside-cwd-"));
    try {
      const error = await refusalOf(() =>
        opencodeRun({
          cwd: outside,
          background: false,
          prompt: "do not leave the active workspace"
        })
      );

      expect(error.code).toBe("workspace_out_of_bounds");
      expect(error.message).toMatch(/working directory.*outside.*workspace/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects prompts that ask OpenCode to read Codex private runtime paths by default", async () => {
    const error = await refusalOf(() =>
      opencodeRun({
        cwd: process.cwd(),
        background: false,
        prompt: "Before reviewing, read /Users/example/.codex/pua/skills/pua/SKILL.md and follow it."
      })
    );

    expect(error.code).toBe("private_path_blocked");
    expect(error.message).toMatch(/Codex private runtime paths/i);
  });

  test("maps automatic permission approval to the current OpenCode --auto flag", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(await opencodeRun({
        cwd: process.cwd(),
        background: false,
        autoApprovePermissions: true,
        prompt: "Run the bounded task."
      }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[] };

      expect(result.ok).toBe(true);
      expect(invocation.args).toContain("--auto");
      expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    });
  });

  test("does not let --auto bypass the Codex private-path prompt guard", async () => {
    const error = await refusalOf(() =>
      opencodeRun({
        cwd: process.cwd(),
        background: false,
        autoApprovePermissions: true,
        prompt: "Read ~/.codex/private/runtime.json."
      })
    );

    expect(error.code).toBe("private_path_blocked");
    expect(error.message).toMatch(/Codex private runtime paths/i);
  });

  test("allows private-path prompts only through the separate explicit boundary", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeRun({
          cwd: process.cwd(),
          background: false,
          allowCodexPrivatePaths: true,
          prompt: "Read ~/.codex/private/runtime.json."
        })
      );
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[]; input: string };

      expect(invocation.input).toContain("~/.codex/private/runtime.json");
      expect(invocation.args).not.toContain("--auto");
    });
  });

  test("lets continue and rescue request permission approval too", async () => {
    // Four of the six recorded auto-rejections were kinds that had no way to ask.
    await withFakeOpenCode(async () => {
      const continued = parseToolResult(
        await opencodeContinue({
          cwd: process.cwd(),
          background: false,
          sessionId: "ses_permission",
          autoApprovePermissions: true,
          prompt: "Continue and finish."
        })
      );
      const rescued = parseToolResult(
        await opencodeRescue({
          cwd: process.cwd(),
          background: false,
          autoApprovePermissions: true,
          problem: "The build fails outside the worktree."
        })
      );

      for (const result of [continued, rescued]) {
        const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[] };
        expect(invocation.args).toContain("--auto");
      }
    });
  });

  test("keeps the deprecated permission alias as --auto only", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(await opencodeRun({
        cwd: process.cwd(),
        background: false,
        dangerouslySkipPermissions: true,
        prompt: "Run the bounded task."
      }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { args: string[] };

      expect(invocation.args).toContain("--auto");
      expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    });
  });
});

describe("timeout budget warnings", () => {
  test("clamps a foreground call to the Codex tools/call ceiling and warns instead of refusing", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeRun({
          cwd: process.cwd(),
          background: false,
          timeoutMs: 900_000,
          prompt: "foreground clamp probe"
        })
      );

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("240000"))).toBe(true);
      expect(result.warnings?.some((warning) => /background:true/.test(warning))).toBe(true);
    });
  });

  test("warns that a low foreground review budget is under the kind p90 but still runs", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeAdversarialReview({
          cwd: process.cwd(),
          background: false,
          timeoutMs: 60_000,
          target: "one file"
        })
      );

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => /p90 wall time for kind=adversarial_review/.test(warning))).toBe(true);
    });
  });

  test("stays silent on a foreground budget that is already within both bounds", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeContinue({
          cwd: process.cwd(),
          background: false,
          timeoutMs: 180_000,
          sessionId: "ses_budget_probe",
          prompt: "no warning probe"
        })
      );

      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });
});

describe("maxToolCalls on the foreground path", () => {
  test("says the ceiling was ignored instead of dropping it silently", async () => {
    // The ceiling is enforced by the background worker, which can interrupt the run
    // and ask the same session for its answer; a foreground call has no such seam.
    // Silently accepting the parameter is the exact behaviour the ruling avoided:
    // the caller would believe the run was bounded when only wall-clock was.
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeRun({
          cwd: process.cwd(),
          background: false,
          maxToolCalls: 3,
          prompt: "foreground ceiling probe"
        })
      );

      expect(result.ok).toBe(true);
      const ignored = (result.warnings ?? []).filter((warning) => /maxToolCalls=3 is ignored/.test(warning));
      expect(ignored).toHaveLength(1);
      expect(ignored[0]).toMatch(/background:false/);
      expect(ignored[0]).toMatch(/background:true/);
    });
  });

  test("stays silent when the caller did not ask for a ceiling", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeRun({ cwd: process.cwd(), background: false, prompt: "no ceiling probe" })
      );

      expect((result.warnings ?? []).some((warning) => /maxToolCalls/.test(warning))).toBe(false);
    });
  });
});

describe("opencodeAdversarialReview", () => {
  test("keeps security/path boundary reviews bounded and prevents security scan escalation", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(await opencodeAdversarialReview({
        cwd: process.cwd(),
        background: false,
        target: "security/path boundary changes in plugins/opencode-plugin-codex/src/tools.ts"
      }));
      const invocation = JSON.parse((result.stdout ?? "").trim()) as { input: string };

      expect(result.ok).toBe(true);
      expect(invocation.input).toContain("bounded failure-mode review");
      expect(invocation.input).toContain("Do not invoke security scan skills");
      expect(invocation.input).toContain("security-diff-scan");
      expect(invocation.input).toContain("Do not spawn subagents for this bounded review");
      expect(invocation.input).toContain("separate explicitly scoped OpenCode task");
    });
  });
});

describe("opencodeTransfer", () => {
  test("rejects explicit rollout files outside the workspace and Codex sessions directory", async () => {
    const error = await refusalOf(() =>
      opencodeTransfer({
        cwd: process.cwd(),
        model: "provider/model",
        rolloutFile: "/etc/hosts"
      })
    );

    expect(error.code).toBe("rollout_invalid");
    expect(error.message).toMatch(/rollout file.*outside/i);
  });

  test("requires an explicit imported session confirmation even when import exits zero", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-fake-import-"));
    const previous = process.env.OPENCODE_BIN;
    try {
      const bin = join(binDir, "fake-import-opencode.mjs");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === '--version') console.log('1.17.15');",
          "else if (process.argv[2] === 'import') console.log('File not found');"
        ].join("\n")
      );
      await chmod(bin, 0o755);
      process.env.OPENCODE_BIN = bin;

      const result = parseToolResult(
        await opencodeTransfer({
          cwd: process.cwd(),
          model: "provider/model",
          rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl")
        })
      ) as ReturnType<typeof parseToolResult> & { error?: { code: string } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("opencode_import_failed");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("verifies an imported session can be read back before reporting transfer success", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-fake-export-"));
    const previous = process.env.OPENCODE_BIN;
    try {
      const bin = join(binDir, "fake-export-opencode.mjs");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === '--version') console.log('1.17.15');",
          "else if (process.argv[2] === 'import') console.log('Imported session: ses_fake_import');",
          "else if (process.argv[2] === 'export') { console.error('session readback failed'); process.exitCode = 1; }"
        ].join("\n")
      );
      await chmod(bin, 0o755);
      process.env.OPENCODE_BIN = bin;

      const result = parseToolResult(
        await opencodeTransfer({
          cwd: process.cwd(),
          model: "provider/model",
          rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl")
        })
      ) as ReturnType<typeof parseToolResult> & { error?: { code: string } };

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("opencode_import_verify_failed");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("reports import success separately when the continuation fails", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-fake-continuation-"));
    const previous = process.env.OPENCODE_BIN;
    try {
      const bin = join(binDir, "fake-continuation-opencode.mjs");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === '--version') console.log('1.17.15');",
          "else if (process.argv[2] === 'import') console.log('Imported session: ses_fake_continue');",
          "else if (process.argv[2] === 'export') console.log(JSON.stringify({ info: { id: 'ses_fake_continue' }, messages: [] }));",
          "else if (process.argv[2] === 'run') { console.error('403 Forbidden: model not authorized'); process.exitCode = 1; }"
        ].join("\n")
      );
      await chmod(bin, 0o755);
      process.env.OPENCODE_BIN = bin;

      const result = parseToolResult(
        await opencodeTransfer({
          cwd: process.cwd(),
          model: "provider/model",
          rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl"),
          runAfterImport: true,
          background: false
        })
      ) as ReturnType<typeof parseToolResult> & {
        importSucceeded?: boolean;
        opencodeSessionId?: string;
        error?: { code: string; message: string; retryable: boolean };
        continuation?: { ok: boolean; errorClass?: string };
      };

      expect(result.ok).toBe(false);
      expect(result.importSucceeded).toBe(true);
      expect(result.opencodeSessionId).toBe("ses_fake_continue");
      expect(result.continuation?.ok).toBe(false);
      expect(result.continuation?.errorClass).toBe("model_unauthorized");
      // ok:false with no error{} is the one shape OC-9 forbids: error.code is what a
      // 0.2 orchestrator switches on, and it used to be undefined here — a caller
      // could only find the cause by digging into data.continuation.
      expect(result.error?.code).toBe("model_unauthorized");
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.message).toContain("ses_fake_continue");
      expect(result.error?.message).toContain("continuation run failed");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("distinguishes a started background continuation from a complete result", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-background-continuation-"));
    const previousBin = process.env.OPENCODE_BIN;
    const previousState = process.env.OPENCODE_PLUGIN_STATE_DIR;
    try {
      const bin = join(binDir, "fake-background-continuation-opencode.mjs");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          "if (process.argv[2] === '--version') console.log('1.17.15');",
          "else if (process.argv[2] === 'import') console.log('Imported session: ses_background_continue');",
          "else if (process.argv[2] === 'export') console.log(JSON.stringify({ info: { id: 'ses_background_continue' }, messages: [] }));",
          "else if (process.argv[2] === 'run') setTimeout(() => process.exit(0), 100);"
        ].join("\n")
      );
      await chmod(bin, 0o755);
      process.env.OPENCODE_BIN = bin;
      process.env.OPENCODE_PLUGIN_STATE_DIR = binDir;

      const result = parseToolResult(
        await opencodeTransfer({
          cwd: process.cwd(),
          model: "provider/model",
          rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl"),
          runAfterImport: true,
          background: true
        })
      ) as ReturnType<typeof parseToolResult> & {
        continuationStarted?: boolean;
        continuationResultComplete?: boolean;
      };

      expect(result.ok).toBe(true);
      expect(result.continuationStarted).toBe(true);
      expect(result.continuationResultComplete).toBe(false);
    } finally {
      if (previousBin === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previousBin;
      if (previousState === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
      else process.env.OPENCODE_PLUGIN_STATE_DIR = previousState;
      await removeWhenQuiet(binDir);
    }
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
      await withTempJob({ id: jobId, status: "cancelled" }, stdout, "", () =>
        opencodeResult({ jobId })
      )
    );

    // ok mirrors the job's outcome, not the query's: a cancelled job is not ok.
    expect(result.ok).toBe(false);
    expect(result.outputSummary?.resultComplete).toBe(false);
    expect(result.outputSummary?.state).toBe("cancelled_partial");
    expect(result.outputSummary?.eventCounts.tool_use).toBe(2);
    expect(result.outputSummary?.sawSubagentTask).toBe(true);
    expect(result.outputSummary?.guidance).toMatch(/partial logs only/i);
  });

  test("marks succeeded OpenCode jobs with assistant text as complete", async () => {
    const jobId = "job_succeeded_text";
    const stdout = await readFile("test/fixtures/opencode-run-events-current.jsonl", "utf8");

    // kind `run`: the same stream under `review` is a zero-tool-call verdict, which is
    // deliberately not a complete result (see test/evidence-counters.test.ts).
    const result = parseToolResult(
      await withTempJob({ id: jobId, kind: "run", status: "succeeded" }, stdout, "", () =>
        opencodeResult({ jobId })
      )
    );

    expect(result.ok).toBe(true);
    expect(result.outputSummary?.resultComplete).toBe(true);
    expect(result.outputSummary?.state).toBe("succeeded_with_text");
    expect(result.outputSummary?.guidance).toMatch(/Codex must still verify/i);
  });

  test("refuses to call a zero-tool-call review verdict a finished result", async () => {
    const jobId = "job_zero_evidence_review";
    const stdout = await readFile("test/fixtures/opencode-run-events-current.jsonl", "utf8");

    const result = parseToolResult(
      await withTempJob({ id: jobId, kind: "review", status: "succeeded" }, stdout, "", () =>
        opencodeResult({ jobId })
      )
    );

    expect(result.outputSummary?.resultComplete).toBe(false);
    expect(result.outputSummary?.toolCallCount).toBe(0);
    expect(result.outputSummary?.evidenceLevel).toBe("none");
    expect((result.outputSummary?.warnings ?? []).join(" ")).toMatch(/opinion, not review/);
  });

  test("does not treat text from an earlier tool-call step as the final result", async () => {
    const jobId = "job_succeeded_midrun_text";
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_midrun" }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_midrun",
        part: { type: "text", text: "I will inspect one more file." }
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_midrun",
        part: { type: "step-finish", reason: "tool-calls" }
      }),
      JSON.stringify({ type: "step_start", sessionID: "ses_midrun" }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_midrun",
        part: { type: "tool", tool: "read" }
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_midrun",
        part: { type: "step-finish", reason: "stop" }
      })
    ].join("\n");

    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded" }, stdout, "", () => opencodeResult({ jobId }))
    );

    expect(result.outputSummary?.resultComplete).toBe(false);
    expect(result.outputSummary?.state).toBe("succeeded_without_text");
  });

  test("routes a timed-out job to session resumption instead of a narrower rerun", async () => {
    const jobId = "job_timeout_resumable";
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_wall" }),
      JSON.stringify({ type: "tool_use", sessionID: "ses_wall", part: { type: "tool", tool: "read" } })
    ].join("\n");

    const result = parseToolResult(
      await withTempJob(
        {
          id: jobId,
          status: "failed",
          errorClass: "timeout",
          errorMessage: "OpenCode exceeded timeoutMs=120000 after producing 2 events. The OpenCode session ses_wall is still resumable.",
          opencodeSessionId: "ses_wall",
          resumable: true
        },
        stdout,
        "",
        () => opencodeResult({ jobId })
      )
    );

    const guidance = result.outputSummary?.guidance ?? "";
    expect(result.outputSummary?.state).toBe("failed_partial");
    expect(guidance).toContain("ses_wall");
    expect(guidance).toContain("opencode_continue");
    expect(guidance).toMatch(/larger timeoutMs/i);
    expect(guidance).toMatch(/re-verify/i);
    expect(guidance).not.toMatch(/narrower prompt/i);
  });

  test("does not offer a resume handle for a timeout that produced no session id", async () => {
    const jobId = "job_timeout_no_handle";
    // Tool calls but no session id: the work happened, the handle did not survive.
    const stdout = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "tool_use", part: { type: "tool", tool: "read", state: { input: { filePath: "a.ts" } } } })
    ].join("\n");
    const result = parseToolResult(
      await withTempJob(
        {
          id: jobId,
          status: "failed",
          errorClass: "timeout",
          errorMessage: "OpenCode exceeded timeoutMs=120000 after producing 2 events. No OpenCode session id was observed.",
          resumable: false
        },
        stdout,
        "",
        () => opencodeResult({ jobId })
      )
    );

    const guidance = result.outputSummary?.guidance ?? "";
    expect(guidance).toMatch(/no OpenCode session id/i);
    expect(guidance).not.toContain("opencode_continue{sessionId");
  });

  test("routes a timeout with zero tool calls to the provider, not to a bigger budget", async () => {
    const jobId = "job_timeout_no_events";
    const result = parseToolResult(
      await withTempJob(
        {
          id: jobId,
          status: "failed",
          errorClass: "timeout",
          timeoutMs: 120_000,
          errorMessage: "OpenCode exceeded timeoutMs=120000 after producing 1 events.",
          resumable: false
        },
        JSON.stringify({ type: "step_start" }),
        "",
        () => opencodeResult({ jobId })
      )
    );

    // The recorded case: two calls burned 120000ms and 180000ms producing one
    // step_start each, then the same task finished in ~15s on a lighter model.
    const guidance = result.outputSummary?.guidance ?? "";
    expect(guidance).toMatch(/without making a single tool call/i);
    expect(guidance).toMatch(/lighter explicit model/i);
    expect(guidance).not.toContain("opencode_continue{sessionId");
  });

  test("classifies an OpenCode JSONL error event even when the CLI exits zero", async () => {
    const jobId = "job_error_event";
    const stdout = JSON.stringify({
      type: "error",
      sessionID: "ses_error",
      error: { name: "APIError", data: { message: "403 Forbidden: model not authorized" } }
    });

    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded", exitCode: 0 }, stdout, "", () =>
        opencodeResult({ jobId })
      )
    );

    expect(result.outputSummary?.resultComplete).toBe(false);
    expect(result.outputSummary?.state).toBe("failed_partial");
    expect(result.outputSummary?.errorClass).toBe("model_unauthorized");
  });
});

describe("opencodeStatus", () => {
  test("exposes the recovery handle on the cheapest poll", async () => {
    const jobId = "job_status_handle";
    const result = parseToolResult(
      await withTempJob(
        {
          id: jobId,
          status: "failed",
          errorClass: "timeout",
          opencodeSessionId: "ses_status_handle",
          resumable: true
        },
        "",
        "",
        () => opencodeStatus({ jobId })
      )
    );

    expect(result.openCodeSessionId).toBe("ses_status_handle");
    expect(result.resumable).toBe(true);
  });

  test("treats a pre-0.2.0 record without the field as not resumable", async () => {
    const jobId = "job_status_legacy";
    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "failed", errorClass: "opencode_failed" }, "", "", () =>
        opencodeStatus({ jobId })
      )
    );

    expect(result.resumable).toBe(false);
    expect(result.openCodeSessionId).toBeUndefined();
  });
});

describe("opencodeResult maxChars contract", () => {
  test("clamps an oversized window and says so instead of failing the call", async () => {
    const jobId = "job_maxchars_clamped";
    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded" }, "x".repeat(2_000), "", () =>
        opencodeResult({ jobId, maxChars: 120_000 })
      )
    );

    expect(result.ok).toBe(true);
    expect(result.maxChars).toBe(100_000);
    expect(result.maxCharsClamped).toBe(true);
  });

  test("reports the effective window when the request is already in range", async () => {
    const jobId = "job_maxchars_in_range";
    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded" }, "x".repeat(2_000), "", () =>
        opencodeResult({ jobId, maxChars: 5_000 })
      )
    );

    expect(result.maxChars).toBe(5_000);
    expect(result.maxCharsClamped).toBe(false);
  });

  test("reports the default window when maxChars is omitted", async () => {
    const jobId = "job_maxchars_default";
    const result = parseToolResult(
      await withTempJob({ id: jobId, status: "succeeded" }, "x".repeat(2_000), "", () =>
        opencodeResult({ jobId })
      )
    );

    expect(result.maxChars).toBe(20_000);
    expect(result.maxCharsClamped).toBe(false);
  });
});

describe("headless delegation preamble", () => {
  test("tells a delegated review to ignore repository persona bootstrap", async () => {
    await withFakeOpenCode(async () => {
      const review = parseToolResult(
        await opencodeReview({ cwd: process.cwd(), background: false, target: "one file" })
      );
      const adversarial = parseToolResult(
        await opencodeAdversarialReview({ cwd: process.cwd(), background: false, target: "one file" })
      );

      for (const result of [review, adversarial]) {
        const invocation = JSON.parse((result.stdout ?? "").trim()) as { input: string };
        expect(invocation.input.startsWith("This is a headless, single-purpose delegation.")).toBe(true);
        expect(invocation.input).toContain("load pua first");
        expect(invocation.input).toContain("Do not narrate steps.");
        // X2: a verdict has to say what it read, and every finding has to point at code.
        expect(invocation.input).toContain("file:line");
        expect(invocation.input).toMatch(/Inspected list/);
      }
      const adversarialPrompt = (JSON.parse((adversarial.stdout ?? "").trim()) as { input: string }).input;
      // The old cap silently truncated adversarial coverage at five findings.
      expect(adversarialPrompt).not.toMatch(/at most 5 findings/);
      expect(adversarialPrompt).toMatch(/sorted by severity/);
    });
  });
});

describe("adversarial review threat model", () => {
  test("carries the caller's operating context and makes out-of-model findings advisory", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeAdversarialReview({
          cwd: process.cwd(),
          background: false,
          target: "src/job-worker.ts",
          threatModel: "single-user local application; no network exposure"
        })
      );
      const prompt = (JSON.parse((result.stdout ?? "").trim()) as { input: string }).input;

      expect(prompt).toContain("Operating context for this review: single-user local application; no network exposure");
      expect(prompt).toMatch(/Label every finding in-model or out-of-model/);
      // The user's own instruction after a filtered turn: stop interrupting the task.
      expect(prompt).toMatch(/never be a blocker, a NO_GO, or a reason to stop work in progress/);
    });
  });

  test("does not invent an operating context when none was given", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeAdversarialReview({ cwd: process.cwd(), background: false, target: "src/job-worker.ts" })
      );
      const prompt = (JSON.parse((result.stdout ?? "").trim()) as { input: string }).input;

      // Claiming "no network exposure" is not something the plugin can know.
      expect(prompt).not.toContain("no network exposure");
      expect(prompt).toMatch(/No operating context was supplied/);
      expect(prompt).toMatch(/advisory rather than blocking/);
    });
  });

  test("frames the review in failure-mode vocabulary, not attack vocabulary", async () => {
    await withFakeOpenCode(async () => {
      const result = parseToolResult(
        await opencodeAdversarialReview({ cwd: process.cwd(), background: false, target: "src/job-worker.ts" })
      );
      const prompt = (JSON.parse((result.stdout ?? "").trim()) as { input: string }).input;

      // A recorded adversarial review tripped the client's own content filter
      // (cyber_policy) and stopped the user's turn.
      for (const word of ["attacker", "malicious", "attack chain", "attack path"]) {
        expect(prompt.toLowerCase(), word).not.toContain(word);
      }
      expect(prompt).toMatch(/failure modes and breakage paths, not as attacks/);
    });
  });
});

describe("opencodeTransfer model default", () => {
  test("falls back to OpenCode's configured model instead of demanding one", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-transfer-default-"));
    const previous = process.env.OPENCODE_BIN;
    try {
      const bin = join(binDir, "fake-transfer-opencode.mjs");
      await writeFile(
        bin,
        [
          "#!/usr/bin/env node",
          "import { writeFileSync } from 'node:fs';",
          "if (process.argv[2] === '--version') console.log('1.18.16');",
          "else if (process.argv[2] === 'debug') console.log(JSON.stringify({ model: 'aihubmix/claude-opus-4-6' }));",
          "else if (process.argv[2] === 'import') { writeFileSync(process.env.FAKE_IMPORT_COPY, process.argv[3]); console.log('Imported session: ses_default_model'); }",
          "else if (process.argv[2] === 'export') console.log(JSON.stringify({ info: { id: 'ses_default_model' }, messages: [] }));"
        ].join("\n")
      );
      await chmod(bin, 0o755);
      process.env.OPENCODE_BIN = bin;
      process.env.FAKE_IMPORT_COPY = join(binDir, "import-path.txt");

      const result = parseToolResult(
        await opencodeTransfer({
          cwd: process.cwd(),
          rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl")
        })
      ) as ReturnType<typeof parseToolResult> & {
        model?: { providerID: string; modelID: string };
        modelSelection?: { source: string };
      };

      // "An explicit authorized model is required" was the wording OC-7 removed
      // everywhere else, and this tool is where it survived.
      expect(result.ok).toBe(true);
      expect(result.model?.providerID).toBe("aihubmix");
      expect(result.modelSelection?.source).toBe("opencode_config");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
      delete process.env.FAKE_IMPORT_COPY;
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
