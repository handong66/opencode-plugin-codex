#!/usr/bin/env node
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeOpenCodeEnv } from "./opencode-cli.js";
import { finalizeJobRecord } from "./job-finalize.js";
import { JobStore, type JobRecord } from "./job-store.js";

const MAX_CAPTURE_CHARS = 1_000_000;

function appendTail(current: string, chunk: string): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= MAX_CAPTURE_CHARS) return { value: combined, truncated: false };
  return { value: combined.slice(-MAX_CAPTURE_CHARS), truncated: true };
}

function signalTree(child: ChildProcess | null, signal: NodeJS.Signals): void {
  const pid = child?.pid;
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForReadyRecord(store: JobStore, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await store.read(jobId);
    if (record.workerPid || record.status === "cancelled") return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not receive its worker PID.`);
}

async function writeLog(path: string, value: string): Promise<void> {
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error("Missing background job ID.");
  const store = new JobStore();
  let record = await waitForReadyRecord(store, jobId);
  if (record.status === "cancelled") {
    await rm(store.inputPath(jobId), { force: true });
    return;
  }

  let child: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  let timedOut = false;
  let cancelRequested = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let flushChain = Promise.resolve();

  const flushLogs = () => {
    const stdoutSnapshot = stdout;
    const stderrSnapshot = stderr;
    flushChain = flushChain.then(async () => {
      await Promise.all([
        writeLog(store.stdoutPath(jobId), stdoutSnapshot),
        writeLog(store.stderrPath(jobId), stderrSnapshot)
      ]);
    });
    void flushChain.catch(() => undefined);
    return flushChain;
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushLogs();
    }, 25);
    flushTimer.unref();
  };

  const requestCancel = () => {
    cancelRequested = true;
    signalTree(child, "SIGTERM");
    forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
    forceKillTimer.unref();
  };
  process.on("SIGTERM", requestCancel);
  process.on("SIGINT", requestCancel);

  try {
    const prompt = await readFile(store.inputPath(jobId), "utf8");
    await rm(store.inputPath(jobId), { force: true });

    record.status = "running";
    record.startedAt = new Date().toISOString();
    await store.write(record);
    await Promise.all([writeLog(store.stdoutPath(jobId), ""), writeLog(store.stderrPath(jobId), "")]);

    child = spawn(record.command, record.args, {
      cwd: record.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizeOpenCodeEnv()
    });
    const outcomePromise = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child?.on("error", (error) => finish({ exitCode: null, signal: null, error }));
      child?.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    });
    const stdinOutcomePromise = new Promise<Error | undefined>((resolve) => {
      const stream = child?.stdin;
      if (!stream) {
        resolve(new Error("OpenCode stdin is unavailable."));
        return;
      }
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        resolve(error);
      };
      stream.once("error", (error) => finish(error));
      stream.once("finish", () => finish());
      stream.once("close", () => finish(new Error("OpenCode stdin closed before the prompt was flushed.")));
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      scheduleFlush();
    });
    child.stderr?.on("data", (chunk: string) => {
      const appended = appendTail(stderr, chunk);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      scheduleFlush();
    });
    record.pid = child.pid;
    await store.write(record);
    child.stdin?.end(prompt);

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, record.timeoutMs);
    timeout.unref();

    const [outcome, stdinError] = await Promise.all([outcomePromise, stdinOutcomePromise]);
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);

    if (flushTimer) clearTimeout(flushTimer);
    await flushLogs();
    const latest = finalizeJobRecord({
      record: await store.read(jobId),
      stdout,
      stderr,
      outcome,
      timedOut,
      cancelRequested,
      stdinError,
      outputTruncated
    });
    await store.write(latest);
  } catch (error) {
    await rm(store.inputPath(jobId), { force: true });
    record = await store.read(jobId).catch(() => record);
    if (record.status !== "cancelled") {
      record.status = "failed";
      record.errorClass = "worker_error";
      record.errorMessage = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      await store.write(record).catch(() => undefined);
    }
    throw error;
  }
}

await main();
