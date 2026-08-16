import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import { MAX_WAIT_MS, opencodeResult, opencodeStatus } from "../plugins/opencode-plugin-codex/src/tools.js";
import { readEnvelope } from "./helpers/envelope.js";

type WaitEnvelope = {
  ok: boolean;
  terminal: boolean;
  nextAction: string;
  waited: number;
  warnings: string[];
  job?: JobRecord;
  record?: JobRecord;
};

async function withStore<T>(
  overrides: Partial<JobRecord>,
  run: (context: { jobId: string; store: JobStore }) => Promise<T>
): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-wait-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = String(overrides.id ?? "job_wait");
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), "");
    await writeFile(store.stderrPath(jobId), "");
    await store.write({
      id: jobId,
      kind: "run",
      status: "running",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      // A live worker: JobStore.status() only reconciles a job whose worker is gone.
      workerPid: process.pid,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 600_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId),
      ...overrides
    });
    return await run({ jobId, store });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PLUGIN_STATE_DIR;
    else process.env.OPENCODE_PLUGIN_STATE_DIR = previous;
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("opencode_status waitMs", () => {
  test("returns immediately when waitMs is omitted", async () => {
    await withStore({ id: "job_wait_none" }, async ({ jobId }) => {
      const startedAt = Date.now();
      const envelope = readEnvelope<WaitEnvelope>(await opencodeStatus({ jobId }));

      expect(envelope.terminal).toBe(false);
      expect(envelope.waited).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(400);
    });
  });

  test("returns as soon as the record goes terminal instead of burning the budget", async () => {
    await withStore({ id: "job_wait_flip" }, async ({ jobId, store }) => {
      const flip = setTimeout(() => {
        void (async () => {
          const record = await store.read(jobId);
          record.status = "succeeded";
          record.exitCode = 0;
          record.finishedAt = new Date().toISOString();
          await store.write(record);
        })();
      }, 700);
      flip.unref?.();

      const startedAt = Date.now();
      const envelope = readEnvelope<WaitEnvelope>(await opencodeStatus({ jobId, waitMs: 8_000 }));
      const elapsed = Date.now() - startedAt;
      clearTimeout(flip);

      expect(envelope.terminal).toBe(true);
      expect(envelope.job?.status).toBe("succeeded");
      expect(envelope.waited).toBeGreaterThan(0);
      // One blocking wait replaced the poll loop; it must not sit out the whole budget.
      expect(elapsed).toBeLessThan(5_000);
    });
  });

  test("gives up at the budget and reports a non-terminal record", async () => {
    await withStore({ id: "job_wait_expire" }, async ({ jobId }) => {
      const envelope = readEnvelope<WaitEnvelope>(await opencodeStatus({ jobId, waitMs: 1_200 }));

      expect(envelope.terminal).toBe(false);
      expect(envelope.job?.status).toBe("running");
      expect(envelope.waited).toBeGreaterThanOrEqual(1_000);
      expect(envelope.nextAction ?? "").not.toContain("do not poll again");
    });
  });

  test("a cancel issued elsewhere ends the wait", async () => {
    await withStore({ id: "job_wait_cancel" }, async ({ jobId, store }) => {
      const cancel = setTimeout(() => {
        void store.cancel(jobId).catch(() => undefined);
      }, 600);
      cancel.unref?.();

      const envelope = readEnvelope<WaitEnvelope>(await opencodeStatus({ jobId, waitMs: 10_000 }));
      clearTimeout(cancel);

      expect(envelope.terminal).toBe(true);
      expect(envelope.ok).toBe(false);
      expect(envelope.job?.status).toBe("cancelled");
    });
  });

  test("clamps an over-long wait to the client's own call ceiling", async () => {
    await withStore(
      { id: "job_wait_clamped", status: "succeeded", finishedAt: new Date().toISOString() },
      async ({ jobId }) => {
        const envelope = readEnvelope<WaitEnvelope>(await opencodeStatus({ jobId, waitMs: 3_000_000 }));

        expect(MAX_WAIT_MS).toBe(240_000);
        expect(envelope.warnings.some((warning) => warning.includes(`clamped to ${MAX_WAIT_MS}`))).toBe(true);
      }
    );
  });
});

describe("opencode_result waitMs", () => {
  test("waits for the terminal record before reading the tail", async () => {
    await withStore({ id: "job_wait_result" }, async ({ jobId, store }) => {
      const flip = setTimeout(() => {
        void (async () => {
          await writeFile(
            store.stdoutPath(jobId),
            [
              JSON.stringify({ type: "step_start", sessionID: "ses_wait" }),
              JSON.stringify({ type: "text", part: { type: "text", text: "final answer" } }),
              JSON.stringify({ type: "step_finish", part: { type: "step_finish", reason: "stop" } })
            ].join("\n")
          );
          const record = await store.read(jobId);
          record.status = "succeeded";
          record.exitCode = 0;
          record.finishedAt = new Date().toISOString();
          await store.write(record);
        })();
      }, 700);
      flip.unref?.();

      const envelope = readEnvelope<WaitEnvelope & { outputSummary: { finalText?: string } }>(
        await opencodeResult({ jobId, waitMs: 8_000 })
      );
      clearTimeout(flip);

      expect(envelope.terminal).toBe(true);
      expect(envelope.waited).toBeGreaterThan(0);
      expect(envelope.outputSummary.finalText).toBe("final answer");
    });
  });
});
