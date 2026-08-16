import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JobStore } from "../plugins/opencode-plugin-codex/src/job-store.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-job-store-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForTerminal(store: JobStore, jobId: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await store.read(jobId);
    if (["succeeded", "failed", "cancelled"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state.`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("JobStore path boundaries", () => {
  test("rejects traversal job IDs before reading outside the job store", async () => {
    const root = await tempDir();
    await writeFile(join(root, "package.json"), '{"name":"outside-job-store"}\n');
    const store = new JobStore(root);

    await expect(store.read("../../package")).rejects.toThrow(/invalid job id/i);
  });

  test("uses private permissions for state directories and job records", async () => {
    const root = await tempDir();
    const store = new JobStore(root);
    const jobId = "job_private_permissions";
    await store.write({
      id: jobId,
      kind: "review",
      status: "queued",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      timeoutMs: 60_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "jobs"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "jobs", `${jobId}.json`))).mode & 0o777).toBe(0o600);
  });
});

describe("JobStore background lifecycle", () => {
  test("does not let a stale worker write overwrite a recorded cancellation", async () => {
    const root = await tempDir();
    const store = new JobStore(root);
    const jobId = "job_cancel_wins";
    const queued = {
      id: jobId,
      kind: "run" as const,
      status: "queued" as const,
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: new Date().toISOString(),
      timeoutMs: 60_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    };
    await store.write(queued);
    const staleWorkerCopy = await store.read(jobId);

    await store.cancel(jobId);
    staleWorkerCopy.status = "succeeded";
    staleWorkerCopy.finishedAt = new Date().toISOString();
    await store.write(staleWorkerCopy);

    expect((await store.read(jobId)).status).toBe("cancelled");
  });

  test("reports stdin delivery failure instead of accepting a child final response", async () => {
    const root = await tempDir();
    const bin = join(root, "closed-stdin-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "import { closeSync } from 'node:fs';",
        "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
        "closeSync(0);",
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_no_stdin' }));",
        "  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_no_stdin', part: { type: 'text', text: 'unrelated final text' } }));",
        "  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_no_stdin', reason: 'stop' }));",
        "}, 100);"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const store = new JobStore(root);

    const job = await store.startOpenCodeJob({
      kind: "run",
      cwd: process.cwd(),
      args: ["run", "--format", "json", "--dir", process.cwd()],
      prompt: "p".repeat(4_000_000),
      timeoutMs: 2_000,
      opencodeBin: bin
    });
    const terminal = await waitForTerminal(store, job.id, 5_000);

    expect(terminal.status).toBe("failed");
    expect(terminal.errorClass).toBe("stdin_error");
  });

  test("reconciles a stale queued record when no worker PID was persisted", async () => {
    const root = await tempDir();
    const store = new JobStore(root);
    const jobId = "job_stale_queued_worker";
    await store.write({
      id: jobId,
      kind: "run",
      status: "queued",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      timeoutMs: 60_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    });
    await writeFile(store.inputPath(jobId), "sensitive prompt", { mode: 0o600 });

    const status = await store.status(jobId);

    expect(status.status).toBe("failed");
    expect(status.errorClass).toBe("worker_unavailable");
    await expect(readFile(store.inputPath(jobId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reconciles a running record whose worker no longer exists", async () => {
    const root = await tempDir();
    const store = new JobStore(root);
    const jobId = "job_stale_worker";
    await store.write({
      id: jobId,
      kind: "run",
      status: "running",
      cwd: process.cwd(),
      command: "opencode",
      args: [],
      workerPid: 99_999_999,
      createdAt: "2026-07-10T00:00:00.000Z",
      startedAt: "2026-07-10T00:00:01.000Z",
      timeoutMs: 60_000,
      stdoutPath: store.stdoutPath(jobId),
      stderrPath: store.stderrPath(jobId)
    });

    const status = await store.status(jobId);

    expect(status.status).toBe("failed");
    expect(status.errorClass).toBe("worker_unavailable");
  });

  test("enforces timeoutMs for background OpenCode jobs", async () => {
    const root = await tempDir();
    const bin = join(root, "slow-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
        "setTimeout(() => { console.log(JSON.stringify({ type: 'step_finish', reason: 'stop' })); }, 500);"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const store = new JobStore(root);

    const job = await store.startOpenCodeJob({
      kind: "run",
      cwd: process.cwd(),
      args: ["run", "--format", "json", "--dir", process.cwd()],
      prompt: "timeout probe",
      timeoutMs: 50,
      opencodeBin: bin
    });
    const terminal = await waitForTerminal(store, job.id);

    expect(terminal.status).toBe("failed");
    expect(terminal.errorClass).toBe("timeout");
    expect(await readFile(join(root, "jobs", `${job.id}.json`), "utf8")).not.toContain("timeout probe");
    await expect(readFile(store.inputPath(job.id), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps the OpenCode session handle when a background job hits its budget", async () => {
    const root = await tempDir();
    const bin = join(root, "hanging-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
        "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_budget_wall' }));",
        "console.log(JSON.stringify({ type: 'tool_use', sessionID: 'ses_budget_wall', part: { type: 'tool', tool: 'read' } }));",
        "setTimeout(() => {}, 60_000);"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const store = new JobStore(root);

    // The caller never passes sessionId on a fresh run, so before OC-2 the 113
    // recorded run timeouts kept no handle at all.
    const job = await store.startOpenCodeJob({
      kind: "run",
      cwd: process.cwd(),
      args: ["run", "--format", "json", "--dir", process.cwd()],
      prompt: "budget wall probe",
      timeoutMs: 300,
      opencodeBin: bin
    });
    const terminal = await waitForTerminal(store, job.id, 5_000);

    expect(terminal.status).toBe("failed");
    expect(terminal.errorClass).toBe("timeout");
    expect(terminal.opencodeSessionId).toBe("ses_budget_wall");
    expect(terminal.resumable).toBe(true);
    expect(terminal.errorMessage).toContain("ses_budget_wall");
    expect(terminal.errorMessage).toContain("timeoutMs=300");

    const { outputSummary } = await store.result(job.id);
    expect(outputSummary.guidance).toContain("opencode_continue");
    expect(outputSummary.openCodeSessionId).toBe("ses_budget_wall");
  });

  test("records a background spawn error when the discovered binary disappears", async () => {
    const root = await tempDir();
    const bin = join(root, "vanishing-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "import { unlink } from 'node:fs/promises';",
        "import { fileURLToPath } from 'node:url';",
        "if (process.argv[2] === '--version') {",
        "  console.log('1.17.15');",
        "  await unlink(fileURLToPath(import.meta.url));",
        "}"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const store = new JobStore(root);

    const job = await store.startOpenCodeJob({
      kind: "run",
      cwd: process.cwd(),
      args: ["run", "--format", "json", "--dir", process.cwd()],
      prompt: "spawn error probe",
      timeoutMs: 1_000,
      opencodeBin: bin
    });
    const deadline = Date.now() + 3_000;
    let terminal = await store.status(job.id);
    while (!["succeeded", "failed", "cancelled"].includes(terminal.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      terminal = await store.status(job.id);
    }

    expect(terminal.status).toBe("failed");
    expect(terminal.errorClass).toBe("spawn_error");
  });
});
