#!/usr/bin/env node
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeOpenCodeEnv } from "./opencode-cli.js";
import {
  buildFinalAnswerArgs,
  finalizeJobRecord,
  isProviderStall,
  readStreamProgress,
  FINAL_ANSWER_PROMPT
} from "./job-finalize.js";
import { JobStore, type JobRecord } from "./job-store.js";

const MAX_CAPTURE_CHARS = 1_000_000;

/**
 * How often the no-progress watchdog re-reads its clock. The rule it applies is
 * `isProviderStall` in job-finalize.ts, where it can be tested without a real
 * 45-second job.
 */
const STALL_CHECK_INTERVAL_MS = 5_000;

/** How often the record's lastEventAt is persisted while a job runs. */
const LAST_EVENT_PERSIST_MS = 10_000;

/** Ceiling on the extra pass that asks for the final answer. */
const FINAL_ANSWER_MAX_MS = 120_000;
const FINAL_ANSWER_MIN_MS = 30_000;

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

/**
 * Ask OpenCode to finish, in the session it is already holding.
 *
 * This is the alternative to SIGTERM when a run walks past its tool-call ceiling:
 * killing it discards everything it read, while the session still has all of it.
 */
async function runFinalAnswerPass(params: {
  record: JobRecord;
  sessionId: string;
  timeoutMs: number;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** Hands the new child to the caller so an opencode_cancel still reaches it. */
  register: (child: ChildProcess) => void;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve) => {
    const child = spawn(params.record.command, buildFinalAnswerArgs(params.record.args, params.sessionId), {
      cwd: params.record.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: sanitizeOpenCodeEnv()
    });
    params.register(child);
    let settled = false;
    const finish = (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      signalTree(child, "SIGTERM");
      setTimeout(() => signalTree(child, "SIGKILL"), 2_000).unref();
    }, params.timeoutMs);
    timeout.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => params.onStdout(chunk));
    child.stderr?.on("data", (chunk: string) => params.onStderr(chunk));
    child.on("error", () => finish({ exitCode: null, signal: null }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    child.stdin?.end(FINAL_ANSWER_PROMPT);
  });
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
  let toolCallCount = 0;
  let streamSessionId: string | undefined = record.opencodeSessionId;
  let pendingLine = "";
  let toolBudgetReached = false;
  let lastEventAt = Date.now();
  let lastEventPersistedAt = 0;
  let stalled: { silentMs: number } | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let flushChain = Promise.resolve();
  /** Serialised progress writes, awaited before the terminal record is written. */
  let progressChain = Promise.resolve();

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

  /**
   * Record when output last arrived, throttled: a caller polling status can then
   * tell "still working" from "silent since", and the watchdog reads the same clock.
   *
   * The writes are serialised on one chain and the chain is awaited before the
   * terminal write. Untracked, this read-modify-write could still be in flight when
   * the job finished and would then put `running` back over the terminal record;
   * JobStore.write now refuses that as well, so this is the near half of the same
   * guard — it also keeps two progress writes from interleaving.
   */
  const noteEvent = () => {
    lastEventAt = Date.now();
    if (lastEventAt - lastEventPersistedAt < LAST_EVENT_PERSIST_MS) return;
    lastEventPersistedAt = lastEventAt;
    const at = new Date(lastEventAt).toISOString();
    progressChain = progressChain.then(async () => {
      const stored = await store.read(jobId).catch(() => undefined);
      if (!stored || ["succeeded", "failed", "cancelled"].includes(stored.status)) return;
      stored.lastEventAt = at;
      await store.write(stored).catch(() => undefined);
    });
    void progressChain.catch(() => undefined);
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
    const requestFinalAnswer = () => {
      if (toolBudgetReached) return;
      toolBudgetReached = true;
      // Not SIGKILL and not a failure: end this pass, then ask the same session for
      // its answer. The alternative — killing the run — discards everything it read.
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    };
    /**
     * Count tool calls on complete lines only; a half-written line cannot be parsed.
     *
     * This runs for every job, not only the ones carrying a `maxToolCalls` ceiling:
     * the watchdog needs to know whether the run has done anything at all, and with
     * the counter maintained only under a ceiling it could not tell "hung before
     * doing anything" from "first tool call is a slow build".
     */
    const trackProgress = (chunk: string) => {
      pendingLine += chunk;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const progress = readStreamProgress(line);
        toolCallCount += progress.toolCalls;
        streamSessionId ??= progress.sessionId;
      }
      if (record.maxToolCalls && toolCallCount >= record.maxToolCalls && streamSessionId) {
        requestFinalAnswer();
      }
    };
    child.stdout?.on("data", (chunk: string) => {
      const appended = appendTail(stdout, chunk);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
      noteEvent();
      trackProgress(chunk);
      scheduleFlush();
    });
    child.stderr?.on("data", (chunk: string) => {
      const appended = appendTail(stderr, chunk);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
      noteEvent();
      scheduleFlush();
    });
    record.pid = child.pid;
    await store.write(record);
    child.stdin?.end(prompt);

    stallTimer = setInterval(() => {
      if (stalled || timedOut || cancelRequested || toolBudgetReached) return;
      const silentMs = Date.now() - lastEventAt;
      if (!isProviderStall({ silentMs, stdoutChars: stdout.length, toolCalls: toolCallCount })) return;
      stalled = { silentMs };
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, STALL_CHECK_INTERVAL_MS);
    stallTimer.unref();

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      forceKillTimer ??= setTimeout(() => signalTree(child, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, record.timeoutMs);
    timeout.unref();

    let [outcome, stdinError] = await Promise.all([outcomePromise, stdinOutcomePromise]);
    clearTimeout(timeout);
    if (stallTimer) clearInterval(stallTimer);
    stallTimer = undefined;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = undefined;

    if (toolBudgetReached && streamSessionId && !cancelRequested && !timedOut) {
      const elapsedMs = Date.now() - Date.parse(record.startedAt ?? record.createdAt);
      const remainingMs = record.timeoutMs - elapsedMs;
      let recordedAnswerPid = Promise.resolve();
      const finalAnswer = await runFinalAnswerPass({
        record,
        sessionId: streamSessionId,
        timeoutMs: Math.max(Math.min(remainingMs, FINAL_ANSWER_MAX_MS), FINAL_ANSWER_MIN_MS),
        onStdout: (chunk) => {
          const appended = appendTail(stdout, chunk);
          stdout = appended.value;
          outputTruncated ||= appended.truncated;
          scheduleFlush();
        },
        onStderr: (chunk) => {
          const appended = appendTail(stderr, chunk);
          stderr = appended.value;
          outputTruncated ||= appended.truncated;
          scheduleFlush();
        },
        register: (nextChild) => {
          child = nextChild;
          // Point the record at the process that is actually running. `record.pid`
          // still named the first child, which this worker already SIGTERMed, so a
          // signal sent to it is swallowed as ESRCH. That is survivable while this
          // worker lives (JobStore.cancel also signals `workerPid`, and the SIGTERM
          // handler forwards to whichever child is current) but not when the worker
          // itself dies during the answer pass: the second child is detached in its
          // own process group, and with its pid recorded nowhere nothing outside
          // this process could ever reach it. opencode_status also stops reporting
          // a dead pid for a job that is still running.
          recordedAnswerPid = (async () => {
            const stored = await store.read(jobId).catch(() => undefined);
            // A terminal record means a cancel already landed; the handler above and
            // JobStore.cancel's workerPid signal cover the child, and writing here
            // would put "running" back over it.
            if (!stored || ["succeeded", "failed", "cancelled"].includes(stored.status)) return;
            stored.pid = nextChild.pid;
            await store.write(stored).catch(() => undefined);
          })();
          void recordedAnswerPid.catch(() => undefined);
          if (cancelRequested) signalTree(child, "SIGTERM");
        }
      });
      await recordedAnswerPid;
      // The interrupted first pass is not the job's outcome; the answer pass is.
      outcome = finalAnswer;
      stdinError = undefined;
    }

    if (flushTimer) clearTimeout(flushTimer);
    await flushLogs();
    // Nothing may still be in flight against the record when the terminal write
    // reads it: a pending progress write would otherwise land afterwards.
    await progressChain;
    const latest = finalizeJobRecord({
      record: {
        ...(await store.read(jobId)),
        toolBudgetReached: toolBudgetReached || undefined,
        lastEventAt: new Date(lastEventAt).toISOString()
      },
      stdout,
      stderr,
      outcome,
      timedOut,
      stalled,
      cancelRequested,
      stdinError,
      outputTruncated
    });
    await store.write(latest);
  } catch (error) {
    if (stallTimer) clearInterval(stallTimer);
    await progressChain.catch(() => undefined);
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
