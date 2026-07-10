import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOpenCodeJsonlError, discoverOpenCode, sanitizeOpenCodeEnv } from "./opencode-cli.js";

export type JobKind =
  | "run"
  | "continue"
  | "rescue"
  | "review"
  | "adversarial_review"
  | "transfer";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  cwd: string;
  command: string;
  args: string[];
  workerPid?: number;
  pid?: number;
  opencodeSessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorClass?: string;
  errorMessage?: string;
  cancelRequestedAt?: string;
  outputTruncated?: boolean;
  stdoutPath: string;
  stderrPath: string;
};

export type JobOutputSummary = {
  resultComplete: boolean;
  state:
    | "queued_partial"
    | "running_partial"
    | "cancelled_partial"
    | "failed_partial"
    | "succeeded_with_text"
    | "succeeded_without_text";
  eventCounts: Record<string, number>;
  openCodeSessionId?: string;
  lastEventType?: string;
  lastTextPreview?: string;
  sawToolUse: boolean;
  sawSubagentTask: boolean;
  errorClass?: string;
  errorMessagePreview?: string;
  guidance: string;
};

export type JobStoreOptions = {
  stateDir?: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const WORKER_STARTUP_GRACE_MS = 2_000;
const MAX_RESULT_CHARS = 100_000;
const SUMMARY_READ_CHARS = 1_000_000;

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

export function defaultJobStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_PLUGIN_STATE_DIR) return resolve(env.OPENCODE_PLUGIN_STATE_DIR);
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home, ".local", "state");
  return join(stateHome, "opencode-plugin-codex");
}

function defaultWorkerPath(env: NodeJS.ProcessEnv): string {
  if (env.OPENCODE_PLUGIN_WORKER_PATH) return resolve(env.OPENCODE_PLUGIN_WORKER_PATH);
  const alongsideBundle = fileURLToPath(new URL("./job-worker.js", import.meta.url));
  if (existsSync(alongsideBundle)) return alongsideBundle;
  return fileURLToPath(new URL("../dist/job-worker.js", import.meta.url));
}

function assertJobId(jobId: string): void {
  if (!/^job_[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new Error("Invalid job ID.");
  }
}

async function readTail(path: string, maxChars: number): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const metadata = await handle.stat();
    const bytesToRead = Math.min(metadata.size, Math.max(maxChars * 4, 4_096));
    if (!bytesToRead) return "";
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, metadata.size - bytesToRead);
    return buffer.subarray(0, bytesRead).toString("utf8").slice(-maxChars);
  } finally {
    await handle.close();
  }
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function summarizeOpenCodeOutput(record: JobRecord, stdout: string, stderr: string): JobOutputSummary {
  const eventCounts: Record<string, number> = {};
  let openCodeSessionId: string | undefined;
  let lastEventType: string | undefined;
  let lastObservedText = "";
  let currentStepText = "";
  let finalText = "";
  let sawTerminalStop = false;
  let sawToolUse = false;
  let sawSubagentTask = false;
  const structuredError = detectOpenCodeJsonlError(stdout, stderr);

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") continue;
    const typedEvent = event as {
      type?: string;
      sessionID?: string;
      reason?: string;
      part?: { type?: string; text?: string; tool?: string; reason?: string };
    };
    const eventType = typedEvent.type ?? typedEvent.part?.type ?? "unknown";
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
    openCodeSessionId ??= typedEvent.sessionID;
    lastEventType = eventType;

    if (eventType === "step_start") {
      currentStepText = "";
      finalText = "";
      sawTerminalStop = false;
    }

    if (eventType === "tool_use" || typedEvent.part?.type === "tool") {
      sawToolUse = true;
      if (typedEvent.part?.tool === "task") sawSubagentTask = true;
    }
    if (eventType === "text" && typeof typedEvent.part?.text === "string" && typedEvent.part.text.trim()) {
      lastObservedText = typedEvent.part.text;
      currentStepText = typedEvent.part.text;
    }
    if (eventType === "step_finish") {
      const reason = typedEvent.part?.reason ?? typedEvent.reason;
      if (reason === "stop") {
        sawTerminalStop = true;
        finalText = currentStepText;
      }
      currentStepText = "";
    }
  }

  let state: JobOutputSummary["state"];
  if (record.status === "failed" || structuredError) state = "failed_partial";
  else if (record.status === "succeeded") {
    state =
      sawTerminalStop && lastEventType === "step_finish" && finalText.trim()
        ? "succeeded_with_text"
        : "succeeded_without_text";
  }
  else if (record.status === "cancelled") state = "cancelled_partial";
  else if (record.status === "queued") state = "queued_partial";
  else state = "running_partial";

  const resultComplete = state === "succeeded_with_text";
  let guidance: string;
  if (resultComplete) {
    guidance = "OpenCode produced final text. Codex must still verify findings against the workspace before acting on them.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "OpenCode is still running. Poll status/result later or cancel and rerun with a narrower target; do not treat current stdout as a final review.";
  } else if (record.status === "cancelled") {
    guidance = "OpenCode was cancelled. stdout/stderr are partial logs only; do not treat them as a final review or implementation result.";
  } else if (record.status === "failed" || structuredError) {
    guidance = stderr.trim()
      ? "OpenCode failed. Inspect stderr and rerun with a narrower prompt or corrected environment."
      : "OpenCode failed without stderr. Rerun with a narrower prompt and inspect the OpenCode session directly if needed.";
  } else {
    guidance = "OpenCode exited successfully but no final assistant text was observed. Rerun with a narrower target and an explicit findings-only output contract.";
  }
  if (!resultComplete && sawSubagentTask) {
    guidance += " A subagent task call was observed, which often indicates the prompt widened beyond a bounded second-pass review.";
  }

  return {
    resultComplete,
    state,
    eventCounts,
    openCodeSessionId,
    lastEventType,
    lastTextPreview: (resultComplete ? finalText : lastObservedText)
      ? previewText(resultComplete ? finalText : lastObservedText)
      : undefined,
    sawToolUse,
    sawSubagentTask,
    errorClass: structuredError?.errorClass ?? record.errorClass,
    errorMessagePreview: structuredError?.message
      ? previewText(structuredError.message)
      : record.errorMessage
        ? previewText(record.errorMessage)
        : undefined,
    guidance
  };
}

export class JobStore {
  readonly stateDir: string;
  readonly workerPath: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: string | JobStoreOptions = {}) {
    const normalized = typeof options === "string" ? { stateDir: options } : options;
    this.env = { ...process.env, ...(normalized.env ?? {}) };
    this.stateDir = resolve(normalized.stateDir ?? defaultJobStateDir(this.env));
    this.workerPath = normalized.workerPath ?? defaultWorkerPath(this.env);
  }

  private jobsDir(): string {
    return join(this.stateDir, "jobs");
  }

  private jobPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.json`);
  }

  private cancelPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.cancel`);
  }

  private async cancellationTimestamp(jobId: string): Promise<string | undefined> {
    try {
      const value = (await readFile(this.cancelPath(jobId), "utf8")).trim();
      return value || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  stdoutPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stdout.log`);
  }

  stderrPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.stderr.log`);
  }

  inputPath(jobId: string): string {
    assertJobId(jobId);
    return join(this.jobsDir(), `${jobId}.input`);
  }

  async ensure(): Promise<void> {
    await mkdir(this.jobsDir(), { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700).catch(() => undefined);
    await chmod(this.jobsDir(), 0o700).catch(() => undefined);
  }

  async write(record: JobRecord): Promise<void> {
    await this.ensure();
    assertJobId(record.id);
    let normalized: JobRecord = {
      ...record,
      stdoutPath: this.stdoutPath(record.id),
      stderrPath: this.stderrPath(record.id)
    };
    if (normalized.status !== "cancelled") {
      const cancelRequestedAt = await this.cancellationTimestamp(record.id);
      if (cancelRequestedAt) {
        normalized = {
          ...normalized,
          status: "cancelled",
          cancelRequestedAt,
          finishedAt: cancelRequestedAt
        };
      }
    }
    const target = this.jobPath(record.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
    if (normalized.status !== "cancelled") {
      const lateCancellation = await this.cancellationTimestamp(record.id);
      if (lateCancellation) {
        await this.write({
          ...normalized,
          status: "cancelled",
          cancelRequestedAt: lateCancellation,
          finishedAt: lateCancellation
        });
      }
    }
  }

  async read(jobId: string): Promise<JobRecord> {
    const raw = await readFile(this.jobPath(jobId), "utf8");
    const record = JSON.parse(raw) as JobRecord;
    if (record.id !== jobId) throw new Error("Job record ID does not match the requested job ID.");
    return {
      ...record,
      stdoutPath: this.stdoutPath(jobId),
      stderrPath: this.stderrPath(jobId)
    };
  }

  async status(jobId: string): Promise<JobRecord> {
    let record = await this.read(jobId);
    if (!["queued", "running"].includes(record.status)) return record;
    if (record.status === "queued" && !record.workerPid) {
      const createdAtMs = Date.parse(record.createdAt);
      if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= WORKER_STARTUP_GRACE_MS) {
        return record;
      }
    }
    if (isProcessAlive(record.workerPid)) return record;

    await new Promise((resolve) => setTimeout(resolve, 25));
    record = await this.read(jobId);
    if (!["queued", "running"].includes(record.status) || isProcessAlive(record.workerPid)) return record;
    record.status = "failed";
    record.errorClass = "worker_unavailable";
    record.errorMessage = "The OpenCode background worker exited without recording a terminal result.";
    record.finishedAt = new Date().toISOString();
    await rm(this.inputPath(jobId), { force: true });
    await this.write(record);
    return record;
  }

  async startOpenCodeJob(params: {
    kind: JobKind;
    cwd: string;
    args: string[];
    prompt: string;
    timeoutMs?: number;
    opencodeBin?: string;
    opencodeSessionId?: string;
  }): Promise<JobRecord> {
    await this.ensure();
    const discovered = await discoverOpenCode({ opencodeBin: params.opencodeBin, env: this.env });
    if (!discovered.ok || !discovered.bin) {
      throw new Error(`OpenCode CLI not found. Tried: ${discovered.tried.join(", ")}`);
    }
    if (!existsSync(this.workerPath)) {
      throw new Error(`OpenCode background worker not found: ${this.workerPath}. Run the plugin build first.`);
    }

    const id = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const record: JobRecord = {
      id,
      kind: params.kind,
      status: "queued",
      cwd: params.cwd,
      command: discovered.bin,
      args: params.args,
      opencodeSessionId: params.opencodeSessionId,
      createdAt: new Date().toISOString(),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      stdoutPath: this.stdoutPath(id),
      stderrPath: this.stderrPath(id)
    };
    await this.write(record);
    await writeFile(this.inputPath(id), params.prompt, { mode: 0o600 });
    await chmod(this.inputPath(id), 0o600);

    const worker = spawn(process.execPath, [this.workerPath, id], {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
      env: sanitizeOpenCodeEnv({
        ...this.env,
        OPENCODE_PLUGIN_STATE_DIR: this.stateDir
      })
    });
    if (!worker.pid) {
      await rm(this.inputPath(id), { force: true });
      throw new Error("Failed to start the OpenCode background worker.");
    }
    record.workerPid = worker.pid;
    await this.write(record);
    worker.unref();
    return record;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.status(jobId);
    if (["succeeded", "failed", "cancelled"].includes(record.status)) return record;

    const cancelRequestedAt = new Date().toISOString();
    await writeFile(this.cancelPath(jobId), cancelRequestedAt, { mode: 0o600 });
    await chmod(this.cancelPath(jobId), 0o600);
    record.status = "cancelled";
    record.cancelRequestedAt = cancelRequestedAt;
    record.finishedAt = cancelRequestedAt;
    await this.write(record);
    await rm(this.inputPath(jobId), { force: true });
    signalProcessTree(record.pid, "SIGTERM");
    signalProcessTree(record.workerPid, "SIGTERM");
    return record;
  }

  async result(
    jobId: string,
    maxChars = 20_000
  ): Promise<{ record: JobRecord; stdout: string; stderr: string; outputSummary: JobOutputSummary }> {
    const record = await this.status(jobId);
    const boundedMaxChars = Math.min(Math.max(maxChars, 1), MAX_RESULT_CHARS);
    const [stdout, stderr, summaryStdout, summaryStderr] = await Promise.all([
      readTail(this.stdoutPath(jobId), boundedMaxChars),
      readTail(this.stderrPath(jobId), boundedMaxChars),
      readTail(this.stdoutPath(jobId), SUMMARY_READ_CHARS),
      readTail(this.stderrPath(jobId), SUMMARY_READ_CHARS)
    ]);
    return {
      record,
      stdout,
      stderr,
      outputSummary: summarizeOpenCodeOutput(record, summaryStdout, summaryStderr)
    };
  }
}
