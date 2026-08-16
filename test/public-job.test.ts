import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore, toPublicJob, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import {
  opencodeCancel,
  opencodeResult,
  opencodeStatus
} from "../plugins/opencode-plugin-codex/src/tools.js";

const INTERNAL_FIELDS = ["command", "args", "workerPid", "pid", "stdoutPath", "stderrPath"];

async function withJob<T>(run: (context: { jobId: string; stateDir: string }) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-public-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = "job_public";
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), "");
    await writeFile(store.stderrPath(jobId), "");
    await store.write({
      id: jobId,
      kind: "review",
      status: "succeeded",
      cwd: process.cwd(),
      command: "/opt/homebrew/bin/opencode",
      args: ["run", "--format", "json", "--model", "aihubmix/claude-opus-4-6"],
      workerPid: 3_187,
      pid: 3_188,
      createdAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:02:00.000Z",
      timeoutMs: 600_000,
      exitCode: 0,
      opencodeSessionId: "ses_public",
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    });
    return await run({ jobId, stateDir });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("toPublicJob", () => {
  test("drops the executable path, argv, pids, and log paths", () => {
    const record = {
      id: "job_x",
      kind: "run",
      status: "failed",
      cwd: "/workspace",
      command: "/opt/homebrew/bin/opencode",
      args: ["run", "--model", "aihubmix/claude-opus-4-6"],
      workerPid: 1,
      pid: 2,
      createdAt: "2026-08-16T00:00:00.000Z",
      timeoutMs: 600_000,
      errorClass: "timeout",
      resumable: true,
      stdoutPath: "/home/user/.local/state/opencode-plugin-codex/jobs/job_x.stdout.log",
      stderrPath: "/home/user/.local/state/opencode-plugin-codex/jobs/job_x.stderr.log"
    } satisfies JobRecord;

    const projected = toPublicJob(record) as Record<string, unknown>;

    for (const field of INTERNAL_FIELDS) expect(projected[field], field).toBeUndefined();
    // Everything a caller acts on survives.
    expect(projected.id).toBe("job_x");
    expect(projected.status).toBe("failed");
    expect(projected.errorClass).toBe("timeout");
    expect(projected.resumable).toBe(true);
    expect(projected.timeoutMs).toBe(600_000);
  });
});

describe("job records on the wire", () => {
  test("status, result and cancel expose no argv, pid, or state path", async () => {
    await withJob(async ({ jobId, stateDir }) => {
      for (const [name, response] of [
        ["opencode_status", await opencodeStatus({ jobId })],
        ["opencode_result", await opencodeResult({ jobId })],
        ["opencode_cancel", await opencodeCancel({ jobId })]
      ] as const) {
        const serialized = JSON.stringify(response.structuredContent);

        // A recorded opencode_status response carried the resolved binary, the whole
        // argv including --model, workerPid 3187, pid 3188, and the absolute state
        // paths — none of which the caller can act on.
        expect(serialized, name).not.toContain("/opt/homebrew/bin/opencode");
        expect(serialized, name).not.toContain("3187");
        expect(serialized, name).not.toContain("3188");
        expect(serialized, name).not.toContain(stateDir);
        expect(serialized, name).not.toContain("stdout.log");
        // The handle a caller actually needs is still there.
        expect(serialized, name).toContain("ses_public");
      }
    });
  });

  test("an unknown job id is a typed refusal, not a raw ENOENT with the state path", async () => {
    await withJob(async ({ stateDir }) => {
      // This is the one call a caller makes *because* it lost its handle, and it
      // used to answer with `isError: true`, no structuredContent, and the text
      // "ENOENT: no such file or directory, open
      // '/Users/<user>/.local/state/opencode-plugin-codex/jobs/<id>.json'".
      for (const [name, response] of [
        ["opencode_status", await opencodeStatus({ jobId: "job_does_not_exist_probe" })],
        ["opencode_result", await opencodeResult({ jobId: "job_does_not_exist_probe" })],
        ["opencode_cancel", await opencodeCancel({ jobId: "job_does_not_exist_probe" })]
      ] as const) {
        const envelope = response.structuredContent as {
          ok: boolean;
          error?: { code: string; retryable: boolean; message: string };
        };
        const serialized = JSON.stringify(response.structuredContent);

        expect((response as { isError?: boolean }).isError, name).not.toBe(true);
        expect(envelope.ok, name).toBe(false);
        expect(envelope.error?.code, name).toBe("job_not_found");
        expect(envelope.error?.retryable, name).toBe(false);
        expect(envelope.error?.message, name).toContain("job_does_not_exist_probe");
        expect(serialized, name).not.toContain(stateDir);
        expect(serialized, name).not.toContain("ENOENT");
        expect(serialized, name).not.toContain(".json");
      }
    });
  });
});
