import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JobStore, toPublicJob, type JobRecord } from "../plugins/opencode-plugin-codex/src/job-store.js";
import {
  opencodeCancel,
  opencodeResult,
  opencodeStatus,
  opencodeTransfer
} from "../plugins/opencode-plugin-codex/src/tools.js";
import { resetOpenCodeDiscoveryCache } from "../plugins/opencode-plugin-codex/src/opencode-cli.js";
import { resetEffectiveModelCache } from "../plugins/opencode-plugin-codex/src/model-guard.js";

const INTERNAL_FIELDS = ["command", "args", "workerPid", "pid", "stdoutPath", "stderrPath"];

const ROLLOUT_FIXTURE = join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl");

afterEach(() => {
  resetOpenCodeDiscoveryCache();
  resetEffectiveModelCache();
});

/** A fake CLI at a path distinctive enough to grep the whole envelope for. */
async function withFakeTransferCli<T>(body: string[], run: (bin: string) => Promise<T>): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-transfer-wire-"));
  const previous = process.env.OPENCODE_BIN;
  try {
    const bin = join(binDir, "fake-transfer-opencode.mjs");
    await writeFile(bin, ["#!/usr/bin/env node", ...body].join("\n"));
    await chmod(bin, 0o755);
    process.env.OPENCODE_BIN = bin;
    resetOpenCodeDiscoveryCache();
    resetEffectiveModelCache();
    return await run(bin);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous;
    await rm(binDir, { recursive: true, force: true });
  }
}

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

  test("a failed transfer import reports the exit code, not the whole ProcessResult", async () => {
    await withFakeTransferCli(
      [
        "if (process.argv[2] === '--version') { console.log('1.18.16'); process.exit(0); }",
        "if (process.argv[2] === 'debug') { console.log(JSON.stringify({ model: 'aihubmix/x' })); process.exit(0); }",
        "if (process.argv[2] === 'import') { console.error('import failed: session store is locked'); process.exit(1); }",
        "console.log('{}');"
      ],
      async (bin) => {
        const response = await opencodeTransfer({ cwd: process.cwd(), rolloutFile: ROLLOUT_FIXTURE });
        const envelope = response.structuredContent as {
          ok: boolean;
          error?: { code: string; message: string; details?: unknown };
        };
        const serialized = JSON.stringify(response.structuredContent);

        expect(envelope.ok).toBe(false);
        expect(envelope.error?.code).toBe("opencode_import_failed");
        // `details: imported` put the resolved binary, the full argv — including the
        // temporary session file this plugin wrote — and both complete streams into
        // the caller's transcript. Only the two facts a caller acts on travel now.
        expect(envelope.error?.details).toEqual({
          exitCode: 1,
          stderrTail: "import failed: session store is locked"
        });
        expect(serialized).not.toContain(bin);
        expect(serialized).not.toContain("session.json");
        expect(serialized).not.toContain('"args"');
        // The CLI's own words still reach the caller.
        expect(envelope.error?.message).toContain("session store is locked");
      }
    );
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
