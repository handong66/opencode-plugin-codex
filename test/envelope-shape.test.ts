import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JobStore, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import {
  configureWorkspaceRootsProvider,
  opencodeResult,
  opencodeRun,
  opencodeStatus
} from "../plugins/opencode-plugin-codex/src/tools.js";

type Wire = {
  ok: boolean;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean; details?: unknown };
  data?: Record<string, unknown>;
} & Record<string, unknown>;

async function withJob<T>(
  overrides: Partial<JobRecord>,
  stdout: string,
  run: (jobId: string) => Promise<T>
): Promise<T> {
  const stateDir = await mkdtemp(join(process.cwd(), ".opencode-plugin-codex-wire-"));
  const previous = process.env.OPENCODE_PLUGIN_STATE_DIR;
  try {
    process.env.OPENCODE_PLUGIN_STATE_DIR = stateDir;
    const store = new JobStore(stateDir);
    const jobId = String(overrides.id ?? "job_wire");
    await store.ensure();
    await writeFile(store.stdoutPath(jobId), stdout);
    await writeFile(store.stderrPath(jobId), "");
    await store.write({
      id: jobId,
      kind: "run",
      status: "succeeded",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:01:00.000Z",
      timeoutMs: 600_000,
      exitCode: 0,
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

describe("every tool returns the same envelope", () => {
  test("meta stays at the top level and the payload lives in data", async () => {
    await withJob({ id: "job_wire_ok" }, "", async (jobId) => {
      const wire = (await opencodeStatus({ jobId })).structuredContent as Wire;

      expect(Object.keys(wire)).toContain("ok");
      expect(Object.keys(wire)).toContain("warnings");
      expect(Array.isArray(wire.warnings)).toBe(true);
      expect(wire.data).toBeDefined();
      // The record is the payload, so it lives in data and nowhere else.
      expect((wire.data as { job?: JobRecord }).job?.id).toBe(jobId);
      expect(wire.error).toBeUndefined();
      // Cheap scalars are mirrored for the 0.2 transition.
      expect(wire.terminal).toBe(true);
      expect(wire.nextAction).toMatch(/do not poll again/i);
    });
  });

  test("bulk fields are never duplicated between the top level and data", async () => {
    const stdout = `${JSON.stringify({ type: "step_start", sessionID: "ses_wire" })}\n${"y".repeat(20_000)}`;

    await withJob({ id: "job_wire_bulk" }, stdout, async (jobId) => {
      const wire = (await opencodeResult({ jobId, maxChars: 20_000 })).structuredContent as Wire;

      // OX2 removed 195,000,000 characters of duplicate payload; grouping under
      // `data` must not put it back.
      for (const bulkField of ["stdout", "stderr", "outputSummary", "record"]) {
        expect(wire[bulkField], bulkField).toBeUndefined();
        expect(wire.data?.[bulkField], bulkField).toBeDefined();
      }
      expect((wire.data?.stdout as string).length).toBeGreaterThan(1_000);
    });
  });

  test("a refusal is the same envelope with a typed error and no data", async () => {
    const outside = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-wire-outside-"));
    configureWorkspaceRootsProvider(async () => [process.cwd()]);
    try {
      const wire = (await opencodeRun({ cwd: outside, prompt: "wire probe" }))
        .structuredContent as Wire;

      expect(wire.ok).toBe(false);
      expect(wire.error?.code).toBe("workspace_out_of_bounds");
      expect(wire.error?.retryable).toBe(false);
      expect(wire.warnings).toEqual([]);
      expect(wire.data).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
