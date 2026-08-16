import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectOpenCodeJsonlError,
  discoveryFailure,
  discoverOpenCode,
  isRetryableOpenCodeFailure,
  openCodeFailureMessage,
  sanitizeOpenCodeEnv
} from "./opencode-cli.js";
import { DEFAULT_TIMEOUT_MS } from "./timeout-budget.js";
import type { ModelSelection } from "./model-guard.js";
import { isBoundaryError, stateWriteFailed } from "./boundary.js";

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
  /**
   * Which model decided this job: OpenCode's own configuration (the caller omitted
   * `model`) or an explicit override. Recorded so a later 403 can be read against
   * what was actually requested.
   */
  modelSelection?: ModelSelection;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  timeoutMs: number;
  /**
   * Optional ceiling on tool calls. Reaching it does not kill the job: the worker
   * asks OpenCode for its final answer from what it already gathered.
   */
  maxToolCalls?: number;
  /** True when that ceiling was reached and the final-answer pass ran. */
  toolBudgetReached?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorClass?: string;
  errorMessage?: string;
  /**
   * True when the OpenCode session behind this record still holds the work and can
   * be continued with opencode_continue. Records written before 0.2.0 omit it;
   * treat a missing value as false.
   */
  resumable?: boolean;
  cancelRequestedAt?: string;
  outputTruncated?: boolean;
  stdoutPath: string;
  stderrPath: string;
};

/**
 * What a caller is allowed to see of a job record.
 *
 * `opencode_status` used to return the whole record: the resolved executable path,
 * the complete argv (including `--model`), `workerPid`, `pid`, and the absolute
 * `~/.local/state/...` log paths. A recorded status response shows all of it. The
 * sibling plugin has projected its records since 0.2 and documents that as a
 * boundary; the field names here are the same ones.
 */
export type PublicJobRecord = Pick<
  JobRecord,
  | "id"
  | "kind"
  | "status"
  | "cwd"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "timeoutMs"
  | "maxToolCalls"
  | "toolBudgetReached"
  | "opencodeSessionId"
  | "modelSelection"
  | "resumable"
  | "exitCode"
  | "signal"
  | "errorClass"
  | "errorMessage"
  | "cancelRequestedAt"
  | "outputTruncated"
>;

const PUBLIC_JOB_FIELDS = [
  "id",
  "kind",
  "status",
  "cwd",
  "createdAt",
  "startedAt",
  "finishedAt",
  "timeoutMs",
  "maxToolCalls",
  "toolBudgetReached",
  "opencodeSessionId",
  "modelSelection",
  "resumable",
  "exitCode",
  "signal",
  "errorClass",
  "errorMessage",
  "cancelRequestedAt",
  "outputTruncated"
] as const satisfies readonly (keyof PublicJobRecord)[];

/**
 * Project a record for the wire. `command`, `args`, `workerPid`, `pid`,
 * `stdoutPath` and `stderrPath` stay inside the plugin: the worker needs them, the
 * caller does not, and `cwd` is already the caller's own input.
 */
export function toPublicJob(record: JobRecord): PublicJobRecord {
  const projected: Record<string, unknown> = {};
  for (const field of PUBLIC_JOB_FIELDS) {
    if (record[field] !== undefined) projected[field] = record[field];
  }
  return projected as PublicJobRecord;
}

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
  /**
   * OpenCode's own final answer, present only when `resultComplete` is true. Field
   * name and semantics match grok-plugin-codex's `outputSummary.finalText` so one
   * orchestrator learns one contract. Bounded at 32,000 characters (the largest
   * recorded answer was 24,811).
   */
  finalText?: string;
  finalTextTruncated: boolean;
  sawToolUse: boolean;
  sawSubagentTask: boolean;
  /** How many tool calls the run made. A verdict with zero is an opinion. */
  toolCallCount: number;
  /** Distinct file paths OpenCode actually opened or searched. */
  filesInspected: number;
  /** OpenCode steps, i.e. model turns. */
  turnsUsed: number;
  /**
   * Interactive skills a headless delegation loaded anyway (repository bootstrap
   * files tell every agent to load a persona first). Deduped and capped.
   */
  skillsLoaded: string[];
  /** Derived from toolCallCount and filesInspected; `none` means nothing was read. */
  evidenceLevel: "none" | "thin" | "substantive";
  /** Advisory notes about the run itself, never a reason to hide the output. */
  warnings: string[];
  /**
   * True when OpenCode asked for a permission it did not get. A job can exit 0 and
   * still have inspected nothing, so this must be read before believing an empty
   * finding set. All six recorded cases were `succeeded_without_text`.
   */
  permissionDenied: boolean;
  /** The paths OpenCode was denied, capped so the summary stays small. */
  deniedPaths: string[];
  errorClass?: string;
  errorMessagePreview?: string;
  guidance: string;
};

/**
 * 'raw' is today's shape (record + stdout/stderr tails + summary). 'final' drops the
 * tails and keeps `outputSummary.finalText`, which is where the answer actually is.
 */
export type JobResultView = "raw" | "final";

export type JobStoreOptions = {
  stateDir?: string;
  workerPath?: string;
  env?: NodeJS.ProcessEnv;
};

const WORKER_STARTUP_GRACE_MS = 2_000;
const MAX_RESULT_CHARS = 100_000;
const SUMMARY_READ_CHARS = 1_000_000;

const MAX_DENIED_PATHS = 5;

/** Budget for the returned final answer. Recorded answers: median 4,226, max 24,811. */
const MAX_FINAL_TEXT_CHARS = 32_000;

const MAX_SKILLS_LOADED = 10;

/** Successful jobs made a median of 5 tool calls; below that is a glance. */
const SUBSTANTIVE_TOOL_CALLS = 5;

/** Kinds whose whole value is having looked at something. */
const REVIEW_KINDS = new Set<JobKind>(["review", "adversarial_review"]);

/** The literal line OpenCode writes to stderr when it auto-rejects a permission. */
const AUTO_REJECT_PATTERN = /permission requested: (\w+) \(([^)]*)\); auto-rejecting/g;

/** The message OpenCode puts on a tool part when the permission was refused. */
const REJECTED_TOOL_STATE_PATTERN = /rejected permission/i;

function collectDeniedPaths(stderr: string): string[] {
  const paths: string[] = [];
  for (const match of stderr.matchAll(AUTO_REJECT_PATTERN)) {
    const path = (match[2] ?? "").trim();
    paths.push(path || match[1]);
  }
  return paths;
}

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
  /** Every text part of the current step. The old code kept only the last one. */
  let currentStepChunks: string[] = [];
  let finalText = "";
  let sawTerminalStop = false;
  let sawToolUse = false;
  let sawSubagentTask = false;
  let toolCallCount = 0;
  let turnsUsed = 0;
  const inspectedPaths = new Set<string>();
  const skillsLoaded = new Set<string>();
  const structuredError = detectOpenCodeJsonlError(stdout, stderr);
  const deniedPaths = collectDeniedPaths(stderr);

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
      part?: {
        type?: string;
        text?: string;
        tool?: string;
        reason?: string;
        state?: { error?: unknown; input?: Record<string, unknown> };
      };
    };
    const eventType = typedEvent.type ?? typedEvent.part?.type ?? "unknown";
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
    openCodeSessionId ??= typedEvent.sessionID;
    lastEventType = eventType;

    if (eventType === "step_start") {
      turnsUsed += 1;
      currentStepChunks = [];
      finalText = "";
      sawTerminalStop = false;
    }

    if (eventType === "tool_use" || typedEvent.part?.type === "tool") {
      sawToolUse = true;
      toolCallCount += 1;
      const tool = typedEvent.part?.tool;
      if (tool === "task") sawSubagentTask = true;
      const state = typedEvent.part?.state;
      const input = state?.input ?? {};
      const inspected = [input.filePath, input.path, input.pattern].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      );
      if (inspected && tool !== "skill") inspectedPaths.add(inspected);
      if (tool === "skill") {
        const name = [input.name, input.skill].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        );
        skillsLoaded.add(name ?? "unnamed skill");
      }
      if (typeof state?.error === "string" && REJECTED_TOOL_STATE_PATTERN.test(state.error)) {
        const deniedTarget = [input.path, input.filePath, input.command].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        );
        deniedPaths.push(deniedTarget ?? tool ?? "unknown target");
      }
    }
    if (eventType === "text" && typeof typedEvent.part?.text === "string" && typedEvent.part.text.trim()) {
      lastObservedText = typedEvent.part.text;
      currentStepChunks.push(typedEvent.part.text);
    }
    if (eventType === "step_finish") {
      const reason = typedEvent.part?.reason ?? typedEvent.reason;
      if (reason === "stop") {
        sawTerminalStop = true;
        finalText = currentStepChunks.join("");
      }
      currentStepChunks = [];
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

  const filesInspected = inspectedPaths.size;
  const evidenceLevel: JobOutputSummary["evidenceLevel"] =
    toolCallCount === 0
      ? "none"
      : toolCallCount >= SUBSTANTIVE_TOOL_CALLS && filesInspected > 0
        ? "substantive"
        : "thin";
  const warnings: string[] = [];

  // A review that opened nothing is an opinion. In the sibling plugin 30 of 64
  // "succeeded" review jobs made zero tool calls and each one was counted as a vote.
  const zeroEvidenceVerdict =
    REVIEW_KINDS.has(record.kind) && state === "succeeded_with_text" && toolCallCount === 0;
  if (zeroEvidenceVerdict) {
    warnings.push("verdict produced with 0 tool calls — treat as opinion, not review");
  }
  if (skillsLoaded.size) {
    warnings.push(
      `OpenCode loaded ${skillsLoaded.size} skill(s) before doing the requested work: ${[...skillsLoaded].join(", ")}. ` +
        "A headless delegation should not be loading interactive personas; that budget is spent before the task starts."
    );
  }

  const resultComplete = state === "succeeded_with_text" && !zeroEvidenceVerdict;
  const boundedDeniedPaths = deniedPaths.slice(0, MAX_DENIED_PATHS);
  const hasFinalText = state === "succeeded_with_text";
  let guidance: string;
  if (resultComplete) {
    guidance = "OpenCode produced final text. Codex must still verify findings against the workspace before acting on them.";
  } else if (zeroEvidenceVerdict) {
    guidance =
      `OpenCode returned a ${record.kind} verdict without making a single tool call, so nothing in the workspace was ` +
      "read. Treat this as an opinion, not a review: do not count it as a passing vote. Rerun with a target it can " +
      "open, and require every finding to cite file:line.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "OpenCode is still running. Poll status/result later or cancel and rerun with a narrower target; do not treat current stdout as a final review.";
  } else if (record.status === "cancelled") {
    guidance = "OpenCode was cancelled. stdout/stderr are partial logs only; do not treat them as a final review or implementation result.";
  } else if (record.errorClass === "timeout" && !structuredError) {
    // A timeout is a budget failure, not an error: the OpenCode session still holds
    // the work, so "rerun with a narrower prompt" throws away everything it did.
    const sessionId = record.opencodeSessionId ?? openCodeSessionId;
    guidance = sessionId
      ? `OpenCode hit the wall-clock budget, not an error. Session ${sessionId} retains the work. ` +
        `Resume with opencode_continue{sessionId:"${sessionId}", prompt:"Continue and produce only the final findings now."} and a larger timeoutMs. ` +
        "Re-verify any file it cites — the tree may have changed since the pause."
      : "OpenCode hit the wall-clock budget, not an error, but no OpenCode session id appeared in its output, " +
        "so there is no resume handle. Rerun with the default timeoutMs of 600000 before narrowing the target.";
  } else if (record.status === "failed" || structuredError) {
    const failureClass = structuredError?.errorClass ?? record.errorClass;
    guidance = isRetryableOpenCodeFailure(failureClass)
      ? stderr.trim()
        ? "OpenCode failed. Inspect stderr and rerun with a narrower prompt or corrected environment."
        : "OpenCode failed without stderr. Rerun with a narrower prompt and inspect the OpenCode session directly if needed."
      : // Retrying a 402 or a 403 spends the user's time to reach the same answer;
        // the class is the signal to route elsewhere, not to try again.
        `${openCodeFailureMessage(failureClass ?? "unknown")} Do not retry this call unchanged.`;
  } else {
    guidance = "OpenCode exited successfully but no final assistant text was observed. Rerun with a narrower target and an explicit findings-only output contract.";
  }
  // Six of six recorded succeeded_without_text jobs were permission auto-rejections,
  // and none of them had asked for --auto. The generic "rerun with a narrower target"
  // advice made the caller shrink the scope of a job that had inspected nothing.
  if (deniedPaths.length) {
    const denial =
      `OpenCode was denied ${deniedPaths.length} permission(s) for ${boundedDeniedPaths.join(", ")}. ` +
      "It exited cleanly but could not inspect what it needed, so absence of findings is NOT evidence of correctness. " +
      "First choose a cwd that already contains those paths. Only if that is impossible, and only with the user's " +
      "explicit approval, retry with autoApprovePermissions:true — OpenCode --auto also approves writes, so do not " +
      "use it for a read-only review.";
    guidance = state === "succeeded_without_text" ? denial : `${denial} ${guidance}`;
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
    lastTextPreview: (hasFinalText ? finalText : lastObservedText)
      ? previewText(hasFinalText ? finalText : lastObservedText)
      : undefined,
    // The answer itself, not a preview of it. Before this the only structured way to
    // read a 4,000-character review was to re-implement this parser on the caller side.
    // Present even for a zero-evidence verdict: the caller has to read what was claimed.
    finalText: hasFinalText ? finalText.slice(0, MAX_FINAL_TEXT_CHARS) : undefined,
    finalTextTruncated: hasFinalText && finalText.length > MAX_FINAL_TEXT_CHARS,
    sawToolUse,
    sawSubagentTask,
    toolCallCount,
    filesInspected,
    turnsUsed,
    skillsLoaded: [...skillsLoaded].slice(0, MAX_SKILLS_LOADED),
    evidenceLevel,
    warnings,
    permissionDenied: deniedPaths.length > 0,
    deniedPaths: boundedDeniedPaths,
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
    try {
      await this.writeUnguarded(record);
    } catch (error) {
      if (isBoundaryError(error)) throw error;
      // One recorded ENOSPC surfaced from this method's temp file as a raw errno
      // with no mention of which directory had filled up.
      throw stateWriteFailed(error, this.stateDir);
    }
  }

  private async writeUnguarded(record: JobRecord): Promise<void> {
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
    maxToolCalls?: number;
    opencodeBin?: string;
    opencodeSessionId?: string;
    modelSelection?: ModelSelection;
  }): Promise<JobRecord> {
    await this.ensure();
    const discovered = await discoverOpenCode({ opencodeBin: params.opencodeBin, env: this.env });
    if (!discovered.ok || !discovered.bin) {
      throw discoveryFailure(discovered);
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
      modelSelection: params.modelSelection,
      createdAt: new Date().toISOString(),
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxToolCalls: params.maxToolCalls,
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
    maxChars = 20_000,
    view: JobResultView = "raw"
  ): Promise<{
    record: JobRecord;
    view: JobResultView;
    rawOmitted?: true;
    stdout?: string;
    stderr?: string;
    maxChars: number;
    maxCharsClamped: boolean;
    outputSummary: JobOutputSummary;
  }> {
    const record = await this.status(jobId);
    const boundedMaxChars = Math.min(Math.max(maxChars, 1), MAX_RESULT_CHARS);
    const [stdout, stderr, summaryStdout, summaryStderr] = await Promise.all([
      readTail(this.stdoutPath(jobId), boundedMaxChars),
      readTail(this.stderrPath(jobId), boundedMaxChars),
      readTail(this.stdoutPath(jobId), SUMMARY_READ_CHARS),
      readTail(this.stderrPath(jobId), SUMMARY_READ_CHARS)
    ]);
    const outputSummary = summarizeOpenCodeOutput(record, summaryStdout, summaryStderr);
    return {
      record,
      view,
      // 'final' is opt-in: the installed collaboration Skill still tells callers to
      // read stderr/JSONL evidence, so the default view cannot change until that
      // document ships the same version.
      ...(view === "final" ? { rawOmitted: true as const } : { stdout, stderr }),
      // The schema used to reject anything above MAX_RESULT_CHARS while the store
      // silently clamped, so a caller widening its window got a protocol error
      // instead of the tail it asked for. Clamp, then say what was used.
      maxChars: boundedMaxChars,
      maxCharsClamped: boundedMaxChars !== maxChars,
      outputSummary
    };
  }
}
