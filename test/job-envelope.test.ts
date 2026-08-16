import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import { opencodeCancel, opencodeResult, opencodeStatus } from "../plugins/opencode-plugin-codex/src/tools.js";

type Envelope = {
  ok: boolean;
  terminal?: boolean;
  nextAction?: string;
  warnings?: string[];
  error?: { code: string; message: string; retryable: boolean };
  job?: JobRecord;
  record?: JobRecord;
};

async function withJob<T>(overrides: Partial<JobRecord>, run: (jobId: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-envelope-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = String(overrides.id ?? "job_envelope");
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), "");
    await writeFile(store.stderrPath(jobId), "");
    await store.write({
      id: jobId,
      kind: "run",
      status: "succeeded",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      timeoutMs: 600_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId),
      ...overrides
    });
    return await run(jobId);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("top-level ok mirrors the job outcome", () => {
  test("a failed job is not reported as ok", async () => {
    // {"ok": true, "job": {"status": "failed"}} was the previous shape.
    await withJob(
      {
        id: "job_envelope_failed",
        status: "failed",
        errorClass: "quota_exhausted",
        errorMessage: "balance exhausted",
        finishedAt: new Date().toISOString()
      },
      async (jobId) => {
        for (const envelope of [
          (await opencodeStatus({ jobId })).structuredContent as Envelope,
          (await opencodeResult({ jobId })).structuredContent as Envelope
        ]) {
          expect(envelope.ok).toBe(false);
          expect(envelope.terminal).toBe(true);
          expect(envelope.error?.code).toBe("quota_exhausted");
          expect(envelope.error?.message).toBe("balance exhausted");
          expect(envelope.error?.retryable).toBe(false);
          expect(envelope.nextAction).toMatch(/do not poll again/i);
        }
      }
    );
  });

  test("a timed-out job is reported as retryable", async () => {
    await withJob(
      {
        id: "job_envelope_timeout",
        status: "failed",
        errorClass: "timeout",
        errorMessage: "OpenCode exceeded timeoutMs=120000",
        finishedAt: new Date().toISOString()
      },
      async (jobId) => {
        const envelope = (await opencodeStatus({ jobId })).structuredContent as Envelope;

        expect(envelope.error?.retryable).toBe(true);
      }
    );
  });

  test("a succeeded job stays ok and terminal", async () => {
    await withJob({ id: "job_envelope_ok", status: "succeeded", finishedAt: new Date().toISOString() }, async (jobId) => {
      const envelope = (await opencodeStatus({ jobId })).structuredContent as Envelope;

      expect(envelope.ok).toBe(true);
      expect(envelope.terminal).toBe(true);
      expect(envelope.error).toBeUndefined();
      expect(envelope.nextAction).toMatch(/do not poll again/i);
    });
  });

  test("a running job is ok, not terminal, and says when to come back", async () => {
    await withJob(
      { id: "job_envelope_running", status: "running", workerPid: process.pid },
      async (jobId) => {
        const envelope = (await opencodeStatus({ jobId })).structuredContent as Envelope;

        expect(envelope.ok).toBe(true);
        expect(envelope.terminal).toBe(false);
        expect(envelope.nextAction).not.toMatch(/do not poll again/i);
        expect(envelope.nextAction).toMatch(/opencode_result/);
      }
    );
  });

  test("cancelling reports the cancelled outcome", async () => {
    // Queued and just created: inside the worker startup grace, so no PID is signalled.
    const overrides = { id: "job_envelope_cancel", status: "queued" as const, createdAt: new Date().toISOString() };
    await withJob(overrides, async (jobId) => {
      const envelope = (await opencodeCancel({ jobId })).structuredContent as Envelope;

      expect(envelope.job?.status).toBe("cancelled");
      expect(envelope.ok).toBe(false);
      expect(envelope.terminal).toBe(true);
      expect(envelope.error?.code).toBe("cancelled");
    });
  });
});

describe("polling a record that cannot change", () => {
  test("warns when a long-finished job is still being polled", async () => {
    const finishedAt = new Date(Date.now() - 20 * 60_000).toISOString();

    await withJob({ id: "job_envelope_stale", status: "succeeded", finishedAt }, async (jobId) => {
      const envelope = (await opencodeStatus({ jobId })).structuredContent as Envelope;

      expect((envelope.warnings ?? []).join(" ")).toMatch(/final/i);
      expect((envelope.warnings ?? []).join(" ")).toMatch(/20 minutes/);
    });
  });

  test("says nothing about a job that just finished", async () => {
    await withJob(
      { id: "job_envelope_fresh", status: "succeeded", finishedAt: new Date().toISOString() },
      async (jobId) => {
        const envelope = (await opencodeStatus({ jobId })).structuredContent as Envelope;

        expect(envelope.warnings).toEqual([]);
      }
    );
  });
});
